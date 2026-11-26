// Production mode set here rather than in package.json, so `npm start` works on Windows too.
process.env.NODE_ENV = "production";
await import("./index.js");
