/**
 * adt/rapGenerator.ts — RAP 產生器(ui-service:由資料表產生 RAP BO 與 OData V4 UI 服務)
 *
 * 不用 abap-adt-api 的 rapGen*:它呼叫 /sap/bc/adt/businessservices/generators/uiservice,
 * A4H(ABAP Cloud Developer Trial 2025)沒有這個端點(rapGenIsAvailable 一律回 false、其餘 404)。
 * A4H 用的是新版框架:/sap/bc/adt/repository/generators?referencedObject=… 列出可用產生器,
 * id 為 ui-service 的項目提供 content / validation / preview / generator 連結(實測在 /sap/bc/adt/rap/generators/ui/ui-service)。
 * 這裡從列表取連結,不寫死路徑。
 */

/** 產生器內容的 Content-Type(A4H 實測) */
export const RAP_CONTENT_TYPE = "application/vnd.sap.adt.serverdriven.content.v1+json; framework=generators.v1";
/** preview 回應(mass operation)的 Content-Type */
export const RAP_PREVIEW_TYPE = "application/vnd.sap.adt.repository.objects.massoperation.v1+xml";
/** 產生器 id */
export const RAP_UI_SERVICE_ID = "ui-service";

export interface RapGeneratorLinks {
  content: string;
  validation: string;
  preview: string;
  generator: string;
}

export interface RapObjectRef {
  uri: string;
  type: string;
  name: string;
}

function decode(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** 從產生器列表(atom feed)找出指定 id 的連結;連結去掉 query(呼叫時再自行帶參數) */
export function findGeneratorLinks(feedXml: string, id: string): RapGeneratorLinks | undefined {
  for (const e of feedXml.matchAll(/<atom:entry\b[^>]*>([\s\S]*?)<\/atom:entry>/g)) {
    if ((e[1].match(/<atom:id>([^<]*)<\/atom:id>/)?.[1] ?? "") !== id) continue;
    const links: Record<string, string> = {};
    for (const l of e[1].matchAll(/<atom:link\b([^>]*)\/?>/g)) {
      const href = decode(l[1].match(/\shref="([^"]*)"/)?.[1] ?? "").split("?")[0];
      const rel = l[1].match(/\srel="[^"]*\/([a-z]+)"/)?.[1] ?? "";
      if (href && rel && !links[rel]) links[rel] = href;
    }
    if (links.content && links.validation && links.preview && links.generator) {
      return { content: links.content, validation: links.validation, preview: links.preview, generator: links.generator };
    }
  }
  return undefined;
}

/** 從 preview / generate 回應取出物件清單 */
export function parseObjectRefs(xml: string): RapObjectRef[] {
  return [...xml.matchAll(/<(?:\w+:)?objectReference\s([^>]*?)\/?>/g)].map((m) => {
    const a = (n: string) => decode(m[1].match(new RegExp(`(?:\\w+:)?${n}="([^"]*)"`))?.[1] ?? "");
    return { uri: a("uri"), type: a("type"), name: a("name") };
  });
}

/** 解析 validationMessages:回傳最嚴重的等級與所有訊息文字 */
export function parseValidationMessages(xml: string): { ok: boolean; messages: string[] } {
  const severities = [...xml.matchAll(/<(?:\w+:)?severity>([^<]*)<\/(?:\w+:)?severity>/gi)].map((m) => m[1].trim().toUpperCase());
  const texts = [...xml.matchAll(/<(?:\w+:)?(?:shortText|text|longText)>([^<]*)<\/(?:\w+:)?(?:shortText|text|longText)>/gi)]
    .map((m) => decode(m[1]).trim())
    .filter(Boolean);
  const ok = !severities.some((s) => s === "ERROR" || s === "E" || s === "FATAL");
  return { ok, messages: texts };
}

/**
 * 套用名稱前綴:產生器預設名稱以 namespace(Z / Y)開頭,例如 ZR_X、ZBP_R_X、ZUI_X_O4;
 * 前綴 ZLEON_ 會把開頭的 Z 換掉 → ZLEON_R_X、ZLEON_BP_R_X、ZLEON_UI_X_O4。
 * 草稿表(draftTable)名稱限 16 字元,保留產生器預設。回傳新的 content(不修改輸入)。
 */
export function applyNamePrefix<T extends object>(content: T, prefix: string): T {
  const copy = JSON.parse(JSON.stringify(content)) as Record<string, unknown>;
  const walk = (o: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === "object") walk(v as Record<string, unknown>);
      else if (
        typeof v === "string" &&
        /Name$/.test(k) &&
        k !== "referencedObjectName" &&
        k !== "projectName" &&
        /^[ZY]/.test(v)
      ) {
        o[k] = prefix + v.slice(1);
      }
    }
  };
  for (const key of ["businessObject", "serviceProjection", "businessService"]) {
    if (copy[key] && typeof copy[key] === "object") walk(copy[key] as Record<string, unknown>);
  }
  const behavior = (copy.businessObject as { behavior?: Record<string, unknown> } | undefined)?.behavior;
  if (behavior && typeof behavior.draftTableOrgn === "string") behavior.draftTable = behavior.draftTableOrgn;
  return copy as T;
}

/** 產生器內容裡的 service binding 名稱 */
export function serviceBindingName(content: object): string {
  const b = (content as { businessService?: { serviceBinding?: { serviceBindingName?: string } } }).businessService;
  return b?.serviceBinding?.serviceBindingName ?? "";
}

/** 從 OData V4 服務資訊(…/odatav4/<binding>)取出服務 URL 與主要 entity set */
export function parseODataV4Service(xml: string): { serviceUrl: string; leadingEntity: string } {
  const serviceUrl = decode(xml.match(/\sodatav4:serviceUrl="([^"]*)"/)?.[1] ?? "");
  const leadingEntity = decode(
    xml.match(/<serviceInfo:collection\b[^>]*serviceInfo:name="([^"]*)"[^>]*serviceInfo:isLeading="true"/)?.[1] ??
      xml.match(/<serviceInfo:collection\b[^>]*serviceInfo:name="([^"]*)"/)?.[1] ??
      ""
  );
  return { serviceUrl, leadingEntity };
}
