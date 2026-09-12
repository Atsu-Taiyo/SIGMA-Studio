function resolveCliLocale(
  environment = process.env,
  systemLocale = Intl.DateTimeFormat().resolvedOptions().locale,
) {
  const environmentLocale = environment.LC_ALL || environment.LC_MESSAGES || environment.LANG;
  const locale = environmentLocale || systemLocale;
  if (!locale) {
    return "ja";
  }
  return /^ja(?:[_-]|$)/i.test(locale) ? "ja" : "en";
}

const messages = {
  ja: {
    windowsOnly:
      "Microsoft Store用AppXはWindowsで生成してください。GitHub Actionsの「Build Windows Store package」を利用できます。",
    missingIdentity: (variables) =>
      `Microsoft Store用AppXの生成にはPartner Centerの製品ID情報が必要です: ${variables.join(", ")}`,
    identityConfigured: "[electron] Microsoft Storeの製品ID情報を確認しました",
  },
  en: {
    windowsOnly:
      'Build the Microsoft Store AppX on Windows. You can use the "Build Windows Store package" GitHub Actions workflow.',
    missingIdentity: (variables) =>
      `Building the Microsoft Store AppX requires these Partner Center product identity values: ${variables.join(", ")}`,
    identityConfigured: "[electron] Microsoft Store product identity is configured",
  },
};

function windowsStoreMessages(environment = process.env) {
  return messages[resolveCliLocale(environment)];
}

module.exports = { resolveCliLocale, windowsStoreMessages };
