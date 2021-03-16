Get-NetTCPConnection | where Localport -eq 5000 | select Localport, OwningProcess
