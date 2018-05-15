<a name="8.1.17"></a>
## [8.1.17](https://github.com/heroku/heroku-cli-command/compare/v8.1.16...v8.1.17) (2018-05-15)


### Bug Fixes

* use caret versions ([0f38127](https://github.com/heroku/heroku-cli-command/commit/0f38127))

<a name="8.1.16"></a>
## [8.1.16](https://github.com/heroku/heroku-cli-command/compare/v8.1.15...v8.1.16) (2018-05-11)


### Bug Fixes

* use CLIError for git error ([0915f57](https://github.com/heroku/heroku-cli-command/commit/0915f57))

<a name="8.1.15"></a>
## [8.1.15](https://github.com/heroku/heroku-cli-command/compare/v8.1.14...v8.1.15) (2018-05-10)


### Bug Fixes

* return request ([d9ae506](https://github.com/heroku/heroku-cli-command/commit/d9ae506))

<a name="8.1.14"></a>
## [8.1.14](https://github.com/heroku/heroku-cli-command/compare/v8.1.13...v8.1.14) (2018-05-10)


### Bug Fixes

* do login first to fix sso login with browser ([1785ded](https://github.com/heroku/heroku-cli-command/commit/1785ded))

<a name="8.1.13"></a>
## [8.1.13](https://github.com/heroku/heroku-cli-command/compare/v8.1.12...v8.1.13) (2018-05-10)


### Bug Fixes

* add retryAuth option ([0c2634a](https://github.com/heroku/heroku-cli-command/commit/0c2634a))

<a name="8.1.12"></a>
## [8.1.12](https://github.com/heroku/heroku-cli-command/compare/v8.1.11...v8.1.12) (2018-05-09)


### Bug Fixes

* show url when HEROKU_TESTING_HEADLESS_LOGIN is set ([c3a3f01](https://github.com/heroku/heroku-cli-command/commit/c3a3f01))

<a name="8.1.11"></a>
## [8.1.11](https://github.com/heroku/heroku-cli-command/compare/v8.1.10...v8.1.11) (2018-05-09)


### Bug Fixes

* show error when opn fails ([6c9fead](https://github.com/heroku/heroku-cli-command/commit/6c9fead))

<a name="8.1.10"></a>
## [8.1.10](https://github.com/heroku/heroku-cli-command/compare/v8.1.9...v8.1.10) (2018-05-08)


### Bug Fixes

* throw plain errors ([a6a821a](https://github.com/heroku/heroku-cli-command/commit/a6a821a))

<a name="8.1.9"></a>
## [8.1.9](https://github.com/heroku/heroku-cli-command/compare/v8.1.8...v8.1.9) (2018-05-08)


### Bug Fixes

* sso logout ([102028a](https://github.com/heroku/heroku-cli-command/commit/102028a))

<a name="8.1.8"></a>
## [8.1.8](https://github.com/heroku/heroku-cli-command/compare/v8.1.7...v8.1.8) (2018-05-08)


### Bug Fixes

* sso login ([747ce09](https://github.com/heroku/heroku-cli-command/commit/747ce09))

<a name="8.1.7"></a>
## [8.1.7](https://github.com/heroku/heroku-cli-command/compare/v8.1.6...v8.1.7) (2018-05-08)


### Bug Fixes

* prettify errors ([6192ae5](https://github.com/heroku/heroku-cli-command/commit/6192ae5))

<a name="8.1.6"></a>
## [8.1.6](https://github.com/heroku/heroku-cli-command/compare/v8.1.5...v8.1.6) (2018-05-08)


### Bug Fixes

* add timeout ([6527877](https://github.com/heroku/heroku-cli-command/commit/6527877))
* unref() login timeout ([c7ea0ab](https://github.com/heroku/heroku-cli-command/commit/c7ea0ab))

<a name="8.1.5"></a>
## [8.1.5](https://github.com/heroku/heroku-cli-command/compare/v8.1.4...v8.1.5) (2018-05-08)


### Bug Fixes

* do not error out if cannot logout ([8978ad4](https://github.com/heroku/heroku-cli-command/commit/8978ad4))

<a name="8.1.4"></a>
## [8.1.4](https://github.com/heroku/heroku-cli-command/compare/v8.1.3...v8.1.4) (2018-05-08)


### Bug Fixes

* make raw requests for http calls ([8629056](https://github.com/heroku/heroku-cli-command/commit/8629056))

<a name="8.1.3"></a>
## [8.1.3](https://github.com/heroku/heroku-cli-command/compare/v8.1.2...v8.1.3) (2018-05-07)


### Bug Fixes

* use jwt auth on browser login ([3ba6ac7](https://github.com/heroku/heroku-cli-command/commit/3ba6ac7))
* web -> browser ([2a78cc0](https://github.com/heroku/heroku-cli-command/commit/2a78cc0))

<a name="8.1.2"></a>
## [8.1.2](https://github.com/heroku/heroku-cli-command/compare/v8.1.1...v8.1.2) (2018-05-06)


### Bug Fixes

* error out on login when HEROKU_API_KEY is set ([eaad07f](https://github.com/heroku/heroku-cli-command/commit/eaad07f))

<a name="8.1.1"></a>
## [8.1.1](https://github.com/heroku/heroku-cli-command/compare/v8.1.0...v8.1.1) (2018-05-06)


### Bug Fixes

* added stubbed browser property ([09b54ad](https://github.com/heroku/heroku-cli-command/commit/09b54ad))

<a name="8.1.0"></a>
# [8.1.0](https://github.com/heroku/heroku-cli-command/compare/v8.0.7...v8.1.0) (2018-05-06)


### Features

* added login/logout ([#33](https://github.com/heroku/heroku-cli-command/issues/33)) ([c772322](https://github.com/heroku/heroku-cli-command/commit/c772322))

<a name="8.0.7"></a>
## [8.0.7](https://github.com/heroku/heroku-cli-command/compare/v8.0.6...v8.0.7) (2018-05-02)


### Bug Fixes

* skip rewriting auth header ([#32](https://github.com/heroku/heroku-cli-command/issues/32)) ([f74245f](https://github.com/heroku/heroku-cli-command/commit/f74245f))

<a name="8.0.6"></a>
## [8.0.6](https://github.com/heroku/heroku-cli-command/compare/v8.0.5...v8.0.6) (2018-05-01)


### Bug Fixes

* updated deps ([e8d6a78](https://github.com/heroku/heroku-cli-command/commit/e8d6a78))

<a name="8.0.5"></a>
## [8.0.5](https://github.com/heroku/heroku-cli-command/compare/v8.0.4...v8.0.5) (2018-04-17)


### Bug Fixes

* updated deps ([56ed61b](https://github.com/heroku/heroku-cli-command/commit/56ed61b))

<a name="8.0.4"></a>
## [8.0.4](https://github.com/heroku/heroku-cli-command/compare/v8.0.3...v8.0.4) (2018-04-06)


### Bug Fixes

* inherit errors from CLIError ([b590cd0](https://github.com/heroku/heroku-cli-command/commit/b590cd0))

<a name="8.0.3"></a>
## [8.0.3](https://github.com/heroku/heroku-cli-command/compare/v8.0.2...v8.0.3) (2018-04-06)


### Bug Fixes

* HEROKU_API_KEY ([7c7d31b](https://github.com/heroku/heroku-cli-command/commit/7c7d31b))

<a name="8.0.2"></a>
## [8.0.2](https://github.com/heroku/heroku-cli-command/compare/v8.0.1...v8.0.2) (2018-04-06)


### Bug Fixes

* memoize auth token ([145f81e](https://github.com/heroku/heroku-cli-command/commit/145f81e))

<a name="8.0.0"></a>
# [8.0.0](https://github.com/heroku/heroku-cli-command/compare/v7.1.1...v8.0.0) (2018-04-06)


### Features

* oclif ([ee07cb1](https://github.com/heroku/heroku-cli-command/commit/ee07cb1))


### BREAKING CHANGES

* this is the oclif version

<a name="7.1.1"></a>
## [7.1.1](https://github.com/heroku/heroku-cli-command/compare/v7.1.0...v7.1.1) (2018-04-06)


### Bug Fixes

* updated metadata ([960d294](https://github.com/heroku/heroku-cli-command/commit/960d294))

<a name="7.1.0"></a>
# [7.1.0](https://github.com/heroku/heroku-cli-command/compare/v7.0.16...v7.1.0) (2018-04-06)


### Bug Fixes

* fixed repo link ([9849b51](https://github.com/heroku/heroku-cli-command/commit/9849b51))
* fixed tests ([525b0a7](https://github.com/heroku/heroku-cli-command/commit/525b0a7))
* oclif rename ([7fc9586](https://github.com/heroku/heroku-cli-command/commit/7fc9586))
* oclif rename ([f3bc43d](https://github.com/heroku/heroku-cli-command/commit/f3bc43d))
* ran oclif generator ([714d15e](https://github.com/heroku/heroku-cli-command/commit/714d15e))
* updated netrc-parser ([df72fd7](https://github.com/heroku/heroku-cli-command/commit/df72fd7))


### Features

* anycli conversion ([201f534](https://github.com/heroku/heroku-cli-command/commit/201f534))
