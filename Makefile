TESTRUN_RELEASE = "./bin/Release/testrun.exe"
TESTRUN_DEBUG = "./bin/Debug/testrun.exe"

vsix: $TESTRUN_RELEASE build
	npm run package

publish: $TESTRUN_RELEASE vsix
	npm run publish

build: $TESTRUN_RELEASE
	npm install
	npm run build

debug: $TESTRUN_DEBUG
	npm install
	npm run build

$TESTRUN_RELEASE:
	msbuild /p:Configuration=Release  /p:Platform="Any CPU" testrun.sln

$TESTRUN_DEBUG:
	msbuild /p:Configuration=Debug  /p:Platform="Any CPU" testrun.sln

clean:
	git clean -xfd
	