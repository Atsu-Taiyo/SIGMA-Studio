#!/usr/bin/env node

import messagesModule from "./windows-store-messages.cjs";

const { windowsStoreMessages } = messagesModule;
const messages = windowsStoreMessages();

const requiredVariables = [
  "WINDOWS_STORE_IDENTITY_NAME",
  "WINDOWS_STORE_PUBLISHER",
  "WINDOWS_STORE_PUBLISHER_DISPLAY_NAME",
];

if (process.platform !== "win32") {
  console.error(messages.windowsOnly);
  process.exit(1);
}

const missingVariables = requiredVariables.filter(
  (name) => !(process.env[name] || "").trim(),
);

if (missingVariables.length > 0) {
  console.error(messages.missingIdentity(missingVariables));
  process.exit(1);
}

console.log(messages.identityConfigured);
