param([string]$File = 'js\tank-editor.js')
$s = Get-Content -Raw -Encoding UTF8 $File
$po = 0; $pc = 0; $bo = 0; $bc = 0
$stack = New-Object System.Collections.Stack
$lineNo = 1
$bad = ''
foreach ($ln in $s -split '\r\n|\n') {
    foreach ($ch in $ln.ToCharArray()) {
        if ($ch -eq '(') { $po++; $stack.Push('(') }
        elseif ($ch -eq ')') {
            $pc++
            if ($stack.Count -gt 0 -and $stack.Peek() -eq '(') { $stack.Pop() }
            else { $bad = "paren imbalance at line $lineNo"; break }
        }
        elseif ($ch -eq '{') { $bo++; $stack.Push('{') }
        elseif ($ch -eq '}') {
            $bc++
            if ($stack.Count -gt 0 -and $stack.Peek() -eq '{') { $stack.Pop() }
            else { $bad = "brace imbalance at line $lineNo"; break }
        }
    }
    if ($bad) { break }
    $lineNo++
}
Write-Output "paren open=$po close=$pc"
Write-Output "brace open=$bo close=$bc"
if ($bad) {
    Write-Output "IMBALANCE: $bad"
} elseif ($stack.Count -gt 0) {
    Write-Output "UNCLOSED STACK: $($stack.ToArray() -join '')"
} else {
    Write-Output "BALANCED"
}
