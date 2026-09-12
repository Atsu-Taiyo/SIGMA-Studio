if (!document.doctype) {
  document.insertBefore(
    document.implementation.createDocumentType("html", "", ""),
    document.documentElement,
  );
}

if (document.compatMode !== "CSS1Compat") {
  Object.defineProperty(document, "compatMode", { value: "CSS1Compat" });
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;
