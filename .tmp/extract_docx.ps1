$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Dump-Docx([string]$src, [string]$dst) {
  $zip = [System.IO.Compression.ZipFile]::OpenRead($src)
  try {
    $entry = $zip.Entries | Where-Object { $_.FullName -eq 'word/document.xml' } | Select-Object -First 1
    $sr = New-Object System.IO.StreamReader($entry.Open())
    $xml = $sr.ReadToEnd()
    $sr.Close()
  } finally {
    $zip.Dispose()
  }
  # 保留结构：段落换行、单元格分隔、制表符
  $xml = $xml -replace '</w:p>', "`r`n"
  $xml = $xml -replace '</w:tc>', ' | '
  $xml = $xml -replace '<w:tab[^>]*/>', "`t"
  $xml = $xml -replace '<w:br[^>]*/>', "`r`n"
  $txt = $xml -replace '<[^>]+>', ''
  $txt = [System.Net.WebUtility]::HtmlDecode($txt)
  $txt = $txt -replace "(\r\n){3,}", "`r`n`r`n"
  [System.IO.File]::WriteAllText($dst, $txt, [System.Text.Encoding]::UTF8)
  $lines = ($txt -split "`r`n").Count
  Write-Output "OK lines=$lines chars=$($txt.Length)"
}

$base = 'D:\csw\中科享链\项目文件\乌能投\数据中台'
$outDir = 'D:\project\univer-demo\.tmp'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Dump-Docx (Join-Path $base '智能填报系统详细设计说明书.docx') (Join-Path $outDir 'design.txt')
