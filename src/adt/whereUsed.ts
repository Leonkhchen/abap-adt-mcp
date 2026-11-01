/**
 * adt/whereUsed.ts — where-used(usageReferences + usageSnippets)的請求與解析
 *
 * 不用 abap-adt-api 的 usageReferences():A4H 回傳的 namespace prefix 是小寫 "usagereferences:",
 * 而 library 只認 "usageReferences:",結果永遠是空陣列(snippet 回應卻又是大寫 R)。
 * 這裡自己解析,prefix 一律不分大小寫。
 */

export interface UsageObject {
  /** 物件或 include 的 URI */
  uri: string;
  name: string;
  type: string;
  packageName: string;
  /** 例如 gradeDirect,includeTest */
  usageInformation: string;
  /** 用於查詢程式碼片段的識別碼(只有實際使用處才有) */
  objectIdentifier: string;
}

export interface UsageSnippet {
  objectIdentifier: string;
  /** 位置 URI(含 #start=行,欄) */
  uri: string;
  content: string;
}

const NS = "http://www.sap.com/adt/ris/usageReferences";

export function usageReferencesBody(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><usagereferences:usageReferenceRequest xmlns:usagereferences="${NS}"><usagereferences:affectedObjects/></usagereferences:usageReferenceRequest>`;
}

export function usageSnippetsBody(objectIdentifiers: string[]): string {
  const ids = objectIdentifiers
    .map((i) => `<usagereferences:objectIdentifier optional="false">${xmlText(i)}</usagereferences:objectIdentifier>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><usagereferences:usageSnippetRequest xmlns:usagereferences="${NS}"><usagereferences:objectIdentifiers>${ids}</usagereferences:objectIdentifiers><usagereferences:affectedObjects/></usagereferences:usageSnippetRequest>`;
}

/** 解析 usageReferences 回應,只回傳實際使用處(有 objectIdentifier 的節點) */
export function parseUsageReferences(xml: string): UsageObject[] {
  const out: UsageObject[] = [];
  for (const m of xml.matchAll(/<(\w+):referencedObject\b([^>]*)>([\s\S]*?)<\/\1:referencedObject>/gi)) {
    const [, , attrs, inner] = m;
    const objectIdentifier = decode(inner.match(/<objectIdentifier>([\s\S]*?)<\/objectIdentifier>/)?.[1] ?? "");
    if (!objectIdentifier) continue;
    const adtObject = inner.match(/<\w+:adtObject\b([^>]*)>/i)?.[1] ?? "";
    out.push({
      uri: attr(attrs, "uri"),
      name: attr(adtObject, "adtcore:name"),
      type: attr(adtObject, "adtcore:type"),
      packageName: attr(inner.match(/<adtcore:packageRef\b([^>]*)\/?>/)?.[1] ?? "", "adtcore:name"),
      usageInformation: attr(attrs, "usageInformation"),
      objectIdentifier,
    });
  }
  return out;
}

/** 解析 usageSnippets 回應 */
export function parseUsageSnippets(xml: string): UsageSnippet[] {
  const out: UsageSnippet[] = [];
  for (const o of xml.matchAll(/<(\w+):codeSnippetObject>([\s\S]*?)<\/\1:codeSnippetObject>/gi)) {
    const inner = o[2];
    const objectIdentifier = decode(inner.match(/<objectIdentifier>([\s\S]*?)<\/objectIdentifier>/)?.[1] ?? "");
    for (const s of inner.matchAll(/<(\w+):codeSnippet\b([^>]*)>([\s\S]*?)<\/\1:codeSnippet>/gi)) {
      out.push({
        objectIdentifier,
        uri: decode(attr(s[2], "uri")),
        content: decode(s[3].match(/<content>([\s\S]*?)<\/content>/)?.[1] ?? "").trim(),
      });
    }
  }
  return out;
}

function attr(attrs: string, name: string): string {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}="([^"]*)"`));
  return m ? decode(m[1]) : "";
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
