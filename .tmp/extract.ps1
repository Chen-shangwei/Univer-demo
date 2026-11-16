$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$src = 'D:\project\univer-demo\.tmp\design.docx'
$dst = 'D:\project\univer-demo\.tmp\design.txt'
$zip = [System.IO.Compression.ZipFile]::OpenRead($src)
try {
  $entry = $zip.Entries | Where-Object { $_.FullName -eq 'word/document.xml' } | Select-Object -First 1
  $sr = New-Object System.IO.StreamReader($entry.Open())
  $xml = $sr.ReadToEnd()
  $sr.Close()
} finally { $zip.Dispose() }
$xml = $xml -replace '</w:p>', "`r`n"
$xml = $xml -replace '</w:tc>', ' | '
$xml = $xml -replace '<w:tab[^>]*/>', "`t"
$xml = $xml -replace '<w:br[^>]*/>', "`r`n"
$txt = $xml -replace '<[^>]+>', ''
$txt = [System.Net.WebUtility]::HtmlDecode($txt)
$txt = $txt -replace "(\r\n){3,}", "`r`n`r`n"
[System.IO.File]::WriteAllText($dst, $txt, [System.Text.Encoding]::UTF8)
Write-Output ("OK lines=" + ($txt -split "`r`n").Count + " chars=" + $txt.Length)
