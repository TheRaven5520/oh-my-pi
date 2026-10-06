# Spring-Silicon omp installer for unsupported Windows hosts
if ($PSVersionTable.PSVersion -lt [version]"5.1") { throw "Windows PowerShell 5.1 or newer is required" }
throw "No Spring-Silicon Windows binary is published; supported: Linux x64, macOS arm64"
