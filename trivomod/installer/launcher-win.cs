using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Windows.Forms;

// Launcher nativo standalone do TrivoMod Installer para Windows (compilado com /target:winexe).
// Embute payload.zip (trivomod + node.exe) como recurso e abre a janela do instalador sem console preto
// e sem exigir Node.js instalado na máquina do usuário.
static class TrivoModInstallerLauncher
{
    private const string ResourceName = "TrivoModPayload.zip";

    [STAThread]
    static void Main(string[] args)
    {
        try
        {
            string runtimeDir = EnsureExtracted();
            string nodeExe = Path.Combine(runtimeDir, "node.exe");
            string cliScript = Path.Combine(runtimeDir, "bin", "trivomod.js");

            if (!File.Exists(nodeExe) || !File.Exists(cliScript))
            {
                MessageBox.Show(
                    "Os arquivos internos do instalador não foram encontrados. Baixe o instalador novamente.",
                    "TrivoMod Installer",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return;
            }

            var psi = new ProcessStartInfo
            {
                FileName = nodeExe,
                Arguments = "\"" + cliScript + "\" gui",
                WorkingDirectory = runtimeDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true
            };

            using (var proc = Process.Start(psi))
            {
                if (proc == null) return;
                string stderr = proc.StandardError.ReadToEnd();
                proc.WaitForExit();
                if (proc.ExitCode != 0 && !string.IsNullOrWhiteSpace(stderr))
                {
                    MessageBox.Show(
                        stderr.Trim(),
                        "TrivoMod Installer",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error
                    );
                }
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "Não foi possível abrir o instalador do TrivoMod:\n\n" + ex.Message,
                "TrivoMod Installer",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
        }
    }

    private static string EnsureExtracted()
    {
        var asm = Assembly.GetExecutingAssembly();
        using (Stream res = asm.GetManifestResourceStream(ResourceName))
        {
            if (res == null)
            {
                throw new InvalidOperationException("Payload interno do instalador ausente.");
            }

            string hash;
            using (var sha = SHA256.Create())
            {
                byte[] digest = sha.ComputeHash(res);
                hash = BitConverter.ToString(digest).Replace("-", "").Substring(0, 12).ToLowerInvariant();
            }

            string baseDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "TrivoMod",
                "installer-runtime",
                hash
            );
            string marker = Path.Combine(baseDir, ".ready");
            if (File.Exists(marker) && File.Exists(Path.Combine(baseDir, "node.exe")))
            {
                return baseDir;
            }

            string tmpDir = baseDir + ".tmp-" + Process.GetCurrentProcess().Id;
            if (Directory.Exists(tmpDir)) Directory.Delete(tmpDir, true);
            Directory.CreateDirectory(tmpDir);

            string tmpZip = tmpDir + ".zip";
            res.Position = 0;
            using (var fs = File.Create(tmpZip))
            {
                res.CopyTo(fs);
            }

            try
            {
                ZipFile.ExtractToDirectory(tmpZip, tmpDir);
            }
            finally
            {
                try { File.Delete(tmpZip); } catch { }
            }

            // Marcador vai dentro de tmpDir: baseDir ainda não existe neste ponto e é criado pelo Move abaixo.
            File.WriteAllText(Path.Combine(tmpDir, ".ready"), hash);

            if (Directory.Exists(baseDir))
            {
                try { Directory.Delete(baseDir, true); } catch { }
            }
            if (!Directory.Exists(baseDir))
            {
                try
                {
                    Directory.Move(tmpDir, baseDir);
                    return baseDir;
                }
                catch (IOException)
                {
                    // Outra instância pode ter concluído a extração ao mesmo tempo.
                    if (File.Exists(marker) && File.Exists(Path.Combine(baseDir, "node.exe")))
                    {
                        try { Directory.Delete(tmpDir, true); } catch { }
                        return baseDir;
                    }
                }
            }
            return tmpDir;
        }
    }
}
