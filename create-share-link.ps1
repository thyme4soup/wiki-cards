$ErrorActionPreference = "Stop"

$accessKey = Read-Host "Read-only MinIO access key"
$secureSecret = Read-Host "Read-only MinIO secret key" -AsSecureString
$secretBuffer = [IntPtr]::Zero

try {
    $secretBuffer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
    $secretKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretBuffer)
    $payload = [ordered]@{
        accessKey = $accessKey
        secretKey = $secretKey
    } | ConvertTo-Json -Compress
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
    $encoded = $encoded.TrimEnd("=").Replace("+", "-").Replace("/", "_")
    Write-Output "https://thyme4soup.github.io/wiki-cards/?cred=$encoded"
}
finally {
    if ($secretBuffer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretBuffer)
    }
    if ($secureSecret) {
        $secureSecret.Dispose()
    }
    $accessKey = $null
    $secretKey = $null
    $payload = $null
    $encoded = $null
}
