
msbuild /p:Configuration=Release testrun.sln
call npm install
call npm run build
call npm run package
