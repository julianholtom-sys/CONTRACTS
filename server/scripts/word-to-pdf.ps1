# Converts a filled Word template to PDF with Microsoft Word.
# -Marked: also export a copy that still shows the {{sig.*}} fields, so their positions can be read.
# Every {{...}} left after filling is removed before the main export.
param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Marked = ""
)
$ErrorActionPreference = "Stop"
$before = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$word = New-Object -ComObject Word.Application
$mine = Get-Process WINWORD -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id } | Sort-Object StartTime -Descending | Select-Object -First 1
if ($mine) { [Console]::Out.WriteLine("PID:$($mine.Id)"); [Console]::Out.Flush() }
$doc = $null
try {
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $word.AutomationSecurity = 3
  $null = @($word.COMAddIns | ForEach-Object { $_.ProgID })
  $doc = $word.Documents.Open($In, $false, $false, $false)
  $doc.ActiveWindow.View.Type = 3
  if ($Marked) {
    $doc.ExportAsFixedFormat($Marked, 17, $false, 0, 0, 1, 1, 0, $true, $true, 0, $true, $true, $false)
  }
  foreach ($story in $doc.StoryRanges) {
    $range = $story
    while ($range -ne $null) {
      $find = $range.Find
      $find.ClearFormatting()
      $find.Replacement.ClearFormatting()
      $null = $find.Execute("\{\{*\}\}", $false, $false, $true, $false, $false, $true, 0, $false, "", 2)
      $range = $range.NextStoryRange
    }
  }
  $doc.ExportAsFixedFormat($Out, 17, $false, 0, 0, 1, 1, 0, $true, $true, 0, $true, $true, $false)
  [Console]::Out.WriteLine("OK")
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($doc -ne $null) { $doc.Close(0) }
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}
