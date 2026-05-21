const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const NodePolyfillPlugin = require('node-polyfill-webpack-plugin');

module.exports = (env, argv) => {
  const isProd = argv.mode === 'production';

  return {
    entry: {
      background: './src/background/sw.ts',
      popup: './src/popup/index.tsx',
      content: './src/content/content.ts',
      inpage: './src/content/inpage.ts',
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      clean: true,
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: { loader: 'ts-loader', options: { transpileOnly: true } },
          exclude: /node_modules/,
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader'],
        },
        {
          // bn.js has "browser": { "buffer": false } in package.json which makes
          // webpack ignore require('buffer'), leaving Buffer undefined in service workers.
          // Disabling aliasFields forces webpack to use resolve.fallback instead.
          test: /node_modules[\\/]bn\.js[\\/]lib[\\/]bn\.js$/,
          resolve: {
            aliasFields: [],
          },
        },
      ],
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.js', '.jsx', '.json'],
      alias: {
        'bn.js': path.resolve(__dirname, 'node_modules/bn.js'),
      },
      fallback: {
        buffer: require.resolve('buffer/'),
        stream: require.resolve('stream-browserify'),
        crypto: require.resolve('crypto-browserify'),
        process: require.resolve('process/browser'),
        path: require.resolve('path-browserify'),
        os: require.resolve('os-browserify/browser'),
        fs: false,
        net: false,
        tls: false,
      },
    },
    plugins: [
      new NodePolyfillPlugin(),
      new webpack.ProvidePlugin({
        process: 'process/browser',
        Buffer: ['buffer', 'Buffer'],
      }),
      new HtmlWebpackPlugin({
        template: './src/popup/popup.html',
        filename: 'popup.html',
        chunks: ['popup'],
      }),
      new CopyWebpackPlugin({
        patterns: [
          { from: 'manifest.json', to: 'manifest.json' },
          { from: 'public', to: '.', noErrorOnMissing: true },
        ],
      }),
    ],
    optimization: {
      minimize: isProd,
    },
    devtool: isProd ? false : 'cheap-module-source-map',
  };
};
