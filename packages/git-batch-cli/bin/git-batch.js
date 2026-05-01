#!/usr/bin/env node

const { main } = require("../src/cli");

main(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    const message = error && error.message ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    process.exitCode = 1;
  });
