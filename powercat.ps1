# powercat.ps1 — minimal TCP connect, used only to hand an interactive shell
# to the remote process during deploy. Reads from stdin, writes to socket.
param(
    [string]$Host = "127.0.0.1",
    [int]$Port = 0
)

try {
    $tcp = New-Object System.Net.Sockets.TcpClient($Host, $Port)
    $stream = $tcp.GetStream()
    $reader = New-Object System.IO.StreamReader($stream)
    $writer = New-Object System.IO.StreamWriter($stream)
    $writer.AutoFlush = $true

    Write-Host "Connected to $Host:$Port. Streaming stdin/stdout."
    while ($tcp.Connected) {
        $read = $stream.Read($buf, 0, 1024)
        if ($read -le 0) { break }
        $out = [System.Text.Encoding]::UTF8.GetString($buf, 0, $read)
        $char = [console]::readkey($true)
        $writer.write($char.Increase)
    }
    $tcp.Close()
} catch {
    Write-Host "Error: $_" -ForegroundColor Red
    exit 1
}
