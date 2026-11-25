/*
 * TrivoMod — hook do Turbopack (equivalente ao findByProps/waitFor do Vencord).
 *
 * Script independente (IIFE, sem módulos) que precisa rodar no mundo principal da
 * página ANTES de qualquer script do site. Ele intercepta `globalThis.TURBOPACK` com
 * getter/setter e embrulha cada factory de módulo empurrada pelos chunks, tanto na
 * fase em que TURBOPACK ainda é um array (chunks que chegaram antes do runtime) quanto
 * depois que o runtime troca o array pelo registry `{ push }`.
 *
 * Como o runtime do Turbopack (browser) chama as factories:
 *   factory.call(?, ctx, module, exports)
 *   - ctx    = instância de `Context` com ctx.m === module e ctx.e === exports;
 *              ctx.i(id) importa, ctx.s([...]) define exports ESM em module.exports,
 *              ctx.v(x) / ctx.n(x) substituem module.exports, ctx.j(...) re-export *,
 *              ctx.a(...) marca módulo assíncrono (module.exports vira uma Promise
 *              com o símbolo "turbopack exports" apontando para os exports reais).
 *   - module = { exports, error, id, namespaceObject }
 * Logo, depois que a factory retorna, `module.exports` é a fonte da verdade.
 *
 * Nada aqui usa eval/new Function (a CSP do site proíbe). Qualquer erro do hook vira
 * log e o push original segue com os argumentos intactos.
 *
 * API: globalThis.__trivomodModules (não enumerável) — ver o objeto `api` no fim.
 */
(() => {
  "use strict";

  const G = globalThis;
  const API_KEY = "__trivomodModules";
  if (Object.prototype.hasOwnProperty.call(G, API_KEY)) return; // já instalado

  const PREFIX = "[TrivoMod:turbopack]";
  const con = G.console;
  const warn = (...args) => {
    try {
      if (con && typeof con.warn === "function") con.warn(PREFIX, ...args);
    } catch (_) {
      /* nunca deixa o log quebrar nada */
    }
  };

  // Referências capturadas cedo, antes que o site possa mexer nelas.
  const fnToString = Function.prototype.toString;
  const hasOwn = Object.prototype.hasOwnProperty;
  const isArray = Array.isArray;
  const reflectApply = Reflect.apply;
  const defineProperty = Object.defineProperty;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const getOwnPropertySymbols = Object.getOwnPropertySymbols;

  /** id -> { id, module, factory } dos módulos já avaliados (ordem de avaliação). */
  const records = new Map();
  /** id -> factory original (vista no push; avaliada ou não). Primeiro vence, como no runtime. */
  const factories = new Map();
  /** factory original -> wrapper */
  const wrapperOf = new WeakMap();
  /** wrapper (factory ou push) -> original */
  const originalOf = new WeakMap();
  /** factory original -> texto (cache preguiçoso para findByCode) */
  const codeCache = new WeakMap();
  /** registros de waitFor pendentes */
  const waiters = new Set();

  let readyResolve;
  const ready = new Promise((resolve) => {
    readyResolve = resolve;
  });
  let isReady = false;
  let current; // valor real de globalThis.TURBOPACK
  let previousArray = null; // último array visto (para reescanear quando o registry chegar)
  let asyncExportsSymbol = null;

  // ---------------------------------------------------------------- exports

  function findAsyncSymbol(promise) {
    if (asyncExportsSymbol && asyncExportsSymbol in promise) return asyncExportsSymbol;
    const syms = getOwnPropertySymbols(promise);
    for (let i = 0; i < syms.length; i++) {
      if (syms[i].description === "turbopack exports") {
        asyncExportsSymbol = syms[i];
        return syms[i];
      }
    }
    return null;
  }

  /** Exports atuais de um registro (resolve módulos assíncronos do Turbopack). */
  function exportsOf(rec) {
    let ex;
    try {
      ex = rec.module.exports;
      if (ex && typeof ex === "object" && typeof ex.then === "function") {
        const sym = findAsyncSymbol(ex);
        if (sym) ex = ex[sym];
      }
    } catch (_) {
      return undefined;
    }
    return ex;
  }

  function codeOfFactory(factory) {
    if (typeof factory !== "function") return "";
    let code = codeCache.get(factory);
    if (code === undefined) {
      try {
        code = reflectApply(fnToString, factory, []);
      } catch (_) {
        code = "";
      }
      codeCache.set(factory, code);
    }
    return code;
  }

  // ---------------------------------------------------------------- filtros

  const NO_MATCH = {};

  function isObjLike(v) {
    return v !== null && (typeof v === "object" || typeof v === "function");
  }

  /** Testa o filtro nos exports e, se não bater, em exports.default. */
  function match(filter, ex, id) {
    if (ex == null || ex === G) return NO_MATCH;
    try {
      if (filter(ex, id)) return ex;
    } catch (_) {
      /* filtros que acessam getters podem lançar; ignoramos */
    }
    try {
      if (isObjLike(ex)) {
        const def = ex.default;
        if (isObjLike(def) && def !== ex && def !== G && filter(def, id)) return def;
      }
    } catch (_) {
      /* idem */
    }
    return NO_MATCH;
  }

  function assertFilter(filter) {
    if (typeof filter !== "function") throw new TypeError(PREFIX + " filtro precisa ser uma função");
  }

  function byProps(...names) {
    if (names.length === 0) throw new TypeError(PREFIX + " byProps precisa de ao menos um nome");
    return (obj) => {
      if (!isObjLike(obj)) return false;
      for (let i = 0; i < names.length; i++) if (!(names[i] in obj)) return false;
      return true;
    };
  }

  function codeMatches(code, subs) {
    for (let i = 0; i < subs.length; i++) {
      const s = subs[i];
      // Checagem estrutural (RegExp de outro realm, ex.: iframe/isolated world).
      if (s !== null && typeof s === "object" && typeof s.test === "function") {
        if ("lastIndex" in s) s.lastIndex = 0;
        if (!s.test(code)) return false;
      } else if (!code.includes(String(s))) return false;
    }
    return true;
  }

  function byCode(...subs) {
    if (subs.length === 0) throw new TypeError(PREFIX + " byCode precisa de ao menos um trecho");
    return (_ex, id) => codeMatches(codeOfId(id), subs);
  }

  function codeOfId(id) {
    const rec = records.get(id);
    return codeOfFactory(rec ? rec.factory : factories.get(id));
  }

  // ---------------------------------------------------------------- busca

  function find(filter) {
    assertFilter(filter);
    for (const rec of records.values()) {
      const m = match(filter, exportsOf(rec), rec.id);
      if (m !== NO_MATCH) return m;
    }
    return undefined;
  }

  function findAll(filter) {
    assertFilter(filter);
    const out = [];
    for (const rec of records.values()) {
      const m = match(filter, exportsOf(rec), rec.id);
      if (m !== NO_MATCH) out.push(m);
    }
    return out;
  }

  function all() {
    const out = new Map();
    for (const rec of records.values()) out.set(rec.id, exportsOf(rec));
    return out;
  }

  /** ids (avaliados ou não) cuja factory contém todos os trechos. */
  function findIdsByCode(...subs) {
    const out = [];
    for (const [id, factory] of factories) if (codeMatches(codeOfFactory(factory), subs)) out.push(id);
    return out;
  }

  // ---------------------------------------------------------------- waitFor

  function waitFor(filter, cb, options) {
    assertFilter(filter);
    if (cb != null && typeof cb !== "function") {
      options = cb;
      cb = null;
    }
    const timeout = options && options.timeout;
    return new Promise((resolve, reject) => {
      let timer = null;
      const entry = {
        filter,
        deliver(value, id) {
          waiters.delete(entry);
          if (timer !== null) clearTimeout(timer);
          if (cb) {
            try {
              cb(value, id);
            } catch (err) {
              warn("erro no callback de waitFor", err);
            }
          }
          resolve(value);
        },
      };
      for (const rec of records.values()) {
        const m = match(filter, exportsOf(rec), rec.id);
        if (m !== NO_MATCH) return entry.deliver(m, rec.id);
      }
      waiters.add(entry);
      if (typeof timeout === "number" && timeout > 0 && typeof setTimeout === "function") {
        timer = setTimeout(() => {
          waiters.delete(entry);
          reject(new Error(PREFIX + " waitFor: tempo esgotado (" + timeout + "ms)"));
        }, timeout);
      }
    });
  }

  function notify(id) {
    if (waiters.size === 0) return;
    const rec = records.get(id);
    if (!rec) return;
    const ex = exportsOf(rec);
    for (const w of Array.from(waiters)) {
      const m = match(w.filter, ex, id);
      if (m !== NO_MATCH) w.deliver(m, id);
    }
  }

  // ---------------------------------------------------------------- hook

  function onEvaluated(ctx, module, factory) {
    let mod = module;
    if (!isObjLike(mod) || !("exports" in mod)) mod = ctx && ctx.m;
    if (!isObjLike(mod)) return;
    const id = mod.id;
    if (id == null) return;
    if (!factories.has(id)) factories.set(id, factory);
    records.set(id, { id, module: mod, factory });
    // Módulo assíncrono: os exports reais só existem quando a Promise resolve.
    const ex = mod.exports;
    if (ex && typeof ex === "object" && typeof ex.then === "function" && findAsyncSymbol(ex)) {
      ex.then(
        () => {
          try {
            notify(id);
          } catch (err) {
            warn("falha ao notificar módulo assíncrono", id, err);
          }
        },
        () => {}
      );
    }
    notify(id);
  }

  function wrapFactory(orig) {
    if (originalOf.has(orig)) return orig; // já é wrapper
    let w = wrapperOf.get(orig);
    if (w) return w;
    w = function (ctx, module) {
      const result = reflectApply(orig, this, arguments);
      try {
        onEvaluated(ctx, module, orig);
      } catch (err) {
        warn("falha ao registrar módulo", err);
      }
      return result;
    };
    originalOf.set(w, orig);
    wrapperOf.set(orig, w);
    return w;
  }

  /**
   * Formato de chunk: [script|path, id, ...ids, factory, id, factory, ...].
   * Vários ids seguidos compartilham a próxima função. Itens que não são array
   * (ex.: { otherChunks, runtimeModuleIds }) passam sem alteração.
   * `inPlace` reescreve o próprio array (usado para itens que já estavam no array).
   */
  function transformChunk(item, inPlace) {
    if (!isArray(item)) return item;
    const out = inPlace ? item : item.slice();
    let pendingIds = [];
    for (let i = 1; i < out.length; i++) {
      const v = out[i];
      if (typeof v === "function") {
        const orig = originalOf.get(v) || v;
        for (let k = 0; k < pendingIds.length; k++) {
          if (!factories.has(pendingIds[k])) factories.set(pendingIds[k], orig);
        }
        pendingIds = [];
        if (v === orig) out[i] = wrapFactory(orig);
      } else if (typeof v === "number" || typeof v === "string") {
        pendingIds.push(v);
      }
    }
    return out;
  }

  function hookedArgs(args) {
    const out = new Array(args.length);
    for (let i = 0; i < args.length; i++) out[i] = transformChunk(args[i], false);
    return out;
  }

  function rescanArray(arr) {
    for (let i = 0; i < arr.length; i++) {
      try {
        transformChunk(arr[i], true);
      } catch (err) {
        warn("falha ao embrulhar chunk já enfileirado", err);
      }
    }
  }

  function patchPush(target) {
    const original = target.push;
    if (typeof original !== "function" || originalOf.has(original)) return;
    const hooked = function push() {
      let args = arguments;
      try {
        args = hookedArgs(arguments);
      } catch (err) {
        warn("falha ao processar push; seguindo sem hook", err);
        args = arguments;
      }
      return reflectApply(original, this, args);
    };
    originalOf.set(hooked, original);
    if (hasOwn.call(target, "push")) target.push = hooked;
    else defineProperty(target, "push", { value: hooked, writable: true, configurable: true, enumerable: false });
  }

  function markReady() {
    if (isReady) return;
    isReady = true;
    readyResolve();
  }

  function adopt(value) {
    if (isArray(value)) {
      previousArray = value;
      rescanArray(value);
      patchPush(value);
    } else if (isObjLike(value) && typeof value.push === "function") {
      // O runtime faz `globalThis.TURBOPACK = { push }` e só DEPOIS `r.forEach(push)`
      // no array antigo: reescanear aqui garante que tudo que está lá vá embrulhado.
      if (previousArray) {
        rescanArray(previousArray);
        previousArray = null;
      }
      patchPush(value);
      markReady();
    }
  }

  function install() {
    const desc = getOwnPropertyDescriptor(G, "TURBOPACK");
    current = desc ? ("value" in desc ? desc.value : G.TURBOPACK) : undefined;
    if (current !== undefined) {
      try {
        adopt(current);
      } catch (err) {
        warn("falha ao adotar TURBOPACK existente", err);
      }
    }
    if (desc && !desc.configurable) {
      warn("globalThis.TURBOPACK não é configurável; hook parcial");
      return;
    }
    defineProperty(G, "TURBOPACK", {
      configurable: true,
      enumerable: desc ? !!desc.enumerable : true,
      get() {
        return current;
      },
      set(value) {
        current = value;
        try {
          adopt(value);
        } catch (err) {
          warn("falha ao adotar novo TURBOPACK", err);
        }
      },
    });
  }

  try {
    install();
  } catch (err) {
    warn("falha ao instalar hook", err);
  }

  // ---------------------------------------------------------------- API

  const api = Object.freeze({
    /** Promise resolvida quando o runtime do Turbopack (registry) aparece. */
    ready,
    /** true depois que o registry apareceu. */
    get isReady() {
      return isReady;
    },
    /** Map id -> exports de todos os módulos já avaliados (cópia). */
    all,
    /** Primeiro exports (ou exports.default) aceito pelo filtro(exports, id). */
    find,
    /** Todos os exports aceitos pelo filtro. */
    findAll,
    /** Primeiro exports que contém todas as propriedades. */
    findByProps: (...names) => find(byProps(...names)),
    /** Exports do primeiro módulo avaliado cuja factory contém todos os trechos (string ou RegExp). */
    findByCode: (...subs) => find(byCode(...subs)),
    /** ids (avaliados ou não) cuja factory contém todos os trechos. */
    findIdsByCode,
    /** Exports de um id (undefined se ainda não avaliado). */
    get: (id) => {
      const rec = records.get(id);
      return rec ? exportsOf(rec) : undefined;
    },
    /** Texto da factory de um id ("" se desconhecido). */
    code: codeOfId,
    /** waitFor(filtro, cb?, { timeout }?) -> Promise<exports>. */
    waitFor,
    /** waitForProps(...nomes) -> Promise<exports>. */
    waitForProps: (...names) => waitFor(byProps(...names)),
    /** waitForCode(...trechos) -> Promise<exports>. */
    waitForCode: (...subs) => waitFor(byCode(...subs)),
    /** Fábricas de filtros reutilizáveis com find/findAll/waitFor. */
    filters: Object.freeze({ byProps, byCode }),
  });

  try {
    defineProperty(G, API_KEY, { value: api, enumerable: false, writable: false, configurable: false });
  } catch (err) {
    warn("falha ao expor " + API_KEY, err);
  }
})();
