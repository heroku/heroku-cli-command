module.exports = {
  recursive: true,
  reporter: 'spec',
  require: [
    'test/helpers/init.js',
    'ts-node/esm',
    'source-map-support/register',
  ],
  timeout: 360000,
  'watch-extensions': 'ts',
}
