param(
  [Parameter(Mandatory = $true)]
  [string]$PayloadPath
)
$ErrorActionPreference = "Stop"
$payload = Get-Content -Raw -Encoding UTF8 $PayloadPath | ConvertFrom-Json
$outlook = New-Object -ComObject Outlook.Application
$mail = $outlook.CreateItem(0)
$mail.To = [string]$payload.to
$mail.Subject = [string]$payload.subject
if ($payload.html) {
  $mail.HTMLBody = [string]$payload.html
} else {
  $mail.Body = [string]$payload.text
}
$ns = $outlook.GetNamespace("MAPI")
$from = [string]$payload.from
$via = ""
foreach ($acc in $ns.Accounts) {
  if (-not $via) { $via = [string]$acc.SmtpAddress }
  if ($from -and $acc.SmtpAddress -eq $from) {
    $mail.SendUsingAccount = $acc
    $via = [string]$acc.SmtpAddress
    break
  }
}
$mail.Send()
Start-Sleep -Milliseconds 1200
@{ via = ("outlook:" + $via) } | ConvertTo-Json -Compress
