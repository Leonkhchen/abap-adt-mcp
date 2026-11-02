/**
 * adt/objectTypes.ts — create_object 支援的物件類型
 *
 * CLAS/OC、INTF/OI、PROG/P、DDLS/DF、TABL/DT 由 abap-adt-api 的 createObject 建立;
 * BDEF/BDO 不在 abap-adt-api 支援範圍內,改由本專案直接呼叫 ADT
 * (/sap/bc/adt/bo/behaviordefinitions,格式已在 A4H 實測)。
 * TABL/DT(資料表)建立後是 SAP 的範本,欄位以 write_source 寫入 define table 原始碼並啟用。
 */

export const CREATABLE_TYPES = ["CLAS/OC", "INTF/OI", "PROG/P", "DDLS/DF", "BDEF/BDO", "TABL/DT"] as const;
export type CreatableType = (typeof CREATABLE_TYPES)[number];

interface TypeInfo {
  /** 物件集合的 ADT 路徑(物件 URI = 此路徑 + / + 小寫名稱) */
  collection: string;
  label: string;
  /** 名稱長度上限 */
  maxLength: number;
}

export const TYPE_INFO: Record<CreatableType, TypeInfo> = {
  "CLAS/OC": { collection: "/sap/bc/adt/oo/classes", label: "Class", maxLength: 30 },
  "INTF/OI": { collection: "/sap/bc/adt/oo/interfaces", label: "Interface", maxLength: 30 },
  "PROG/P": { collection: "/sap/bc/adt/programs/programs", label: "Program", maxLength: 30 },
  "DDLS/DF": { collection: "/sap/bc/adt/ddic/ddl/sources", label: "CDS Data Definition", maxLength: 30 },
  "BDEF/BDO": { collection: "/sap/bc/adt/bo/behaviordefinitions", label: "Behavior Definition", maxLength: 30 },
  "TABL/DT": { collection: "/sap/bc/adt/ddic/tables", label: "Database Table", maxLength: 16 },
};

/** source URI 的尾端:/source/main 或 class 的 include(例如 /includes/testclasses) */
const SOURCE_SUFFIX = /\/(source\/[^/]+|includes\/[^/]+)$/;

/** 是否已是 source URI(/source/main 或 /includes/xxx) */
export function isSourceUrl(url: string): boolean {
  return SOURCE_SUFFIX.test(url);
}

/** source URI → 物件 URI,例如 …/zcl_demo/includes/testclasses → …/zcl_demo */
export function baseObjectUrl(url: string): string {
  return url.replace(SOURCE_SUFFIX, "");
}

/** class 的測試 include(ABAP Unit 測試類別所在) */
export function isTestClassesInclude(url: string): boolean {
  return /\/oo\/classes\/[^/]+\/includes\/testclasses$/.test(url);
}

/** 新物件的 ADT URI,例如 /sap/bc/adt/oo/classes/zcl_demo */
export function newObjectUrl(type: CreatableType, name: string): string {
  return `${TYPE_INFO[type].collection}/${encodeURIComponent(name.toLowerCase())}`;
}

/** package 的 ADT URI,例如 /sap/bc/adt/packages/%24tmp */
export function packageUrl(packageName: string): string {
  return `/sap/bc/adt/packages/${encodeURIComponent(packageName.toLowerCase())}`;
}

/** 本機物件 package($ 開頭)不需要 transport */
export function isLocalPackage(packageName: string): boolean {
  return packageName.startsWith("$");
}

/** XML 屬性值跳脫 */
export function xmlAttr(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** BDEF 建立請求的 XML(A4H 實測可用;SAP 會依 root entity 產生範本原始碼) */
export function bdefCreateBody(o: {
  name: string;
  packageName: string;
  description: string;
  responsible: string;
  language: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<blue:blueSource xmlns:blue="http://www.sap.com/wbobj/blue" xmlns:adtcore="http://www.sap.com/adt/core"
  adtcore:description="${xmlAttr(o.description)}" adtcore:name="${xmlAttr(o.name.toUpperCase())}" adtcore:type="BDEF/BDO"
  adtcore:language="${xmlAttr(o.language)}" adtcore:masterLanguage="${xmlAttr(o.language)}" adtcore:responsible="${xmlAttr(o.responsible.toUpperCase())}">
  <adtcore:packageRef adtcore:name="${xmlAttr(o.packageName.toUpperCase())}"/>
</blue:blueSource>`;
}

/** 解析 ADT validation 回應(asx:abap 格式)的 SEVERITY / SHORT_TEXT */
export function parseValidation(xml: string): { severity: string; text: string } {
  const severity = xml.match(/<SEVERITY>([^<]*)<\/SEVERITY>/)?.[1] ?? "";
  const text = xml.match(/<SHORT_TEXT>([^<]*)<\/SHORT_TEXT>/)?.[1] ?? "";
  return { severity, text };
}
