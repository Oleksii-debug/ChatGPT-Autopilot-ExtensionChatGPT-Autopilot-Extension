using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;

internal static class NativeHostLauncher
{
    private static string Quote(string value)
    {
        return "\"" + (value ?? string.Empty).Replace("\"", "\\\"") + "\"";
    }

    public static int Main(string[] args)
    {
        try
        {
            var baseDir = AppDomain.CurrentDomain.BaseDirectory;
            var nodeExe = Path.Combine(baseDir, "runtime", "node.exe");
            var hostScript = Path.Combine(baseDir, "host.mjs");
            if (!File.Exists(nodeExe) || !File.Exists(hostScript))
            {
                Console.Error.WriteLine("Native Companion runtime is incomplete.");
                return 20;
            }

            var arguments = Quote(hostScript);
            if (args != null && args.Length > 0)
            {
                arguments += " " + string.Join(" ", args.Select(Quote));
            }

            var start = new ProcessStartInfo(nodeExe, arguments)
            {
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                WorkingDirectory = baseDir,
            };

            using (var child = Process.Start(start))
            {
                if (child == null) return 21;
                var stdin = Console.OpenStandardInput();
                var stdout = Console.OpenStandardOutput();
                var stderr = Console.OpenStandardError();

                var inputTask = stdin.CopyToAsync(child.StandardInput.BaseStream).ContinueWith(_ =>
                {
                    try { child.StandardInput.Close(); } catch { }
                });
                var outputTask = child.StandardOutput.BaseStream.CopyToAsync(stdout);
                var errorTask = child.StandardError.BaseStream.CopyToAsync(stderr);

                child.WaitForExit();
                try { Task.WaitAll(new[] { outputTask, errorTask }, 5000); } catch { }
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Native Companion launcher failed: " + error.Message);
            return 22;
        }
    }
}
