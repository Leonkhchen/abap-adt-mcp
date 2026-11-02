/**
 * adt/activation.ts — 批次啟用的請求與回應
 *
 * 不用 abap-adt-api 的 activate(陣列):它會在每個 objectReference 帶上 adtcore:type 與 adtcore:parentUri,
 * A4H 對這種請求一律回「Check of condition failed」(主物件、含子項目、preaudit 開關都一樣)。
 * 只帶 adtcore:uri + adtcore:name(與單一物件啟用相同的形狀)時,單筆與多筆都能正常啟用。
 */
import type { ActivationResult, ActivationResultMessage } from "abap-adt-api";

function xmlAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function decode(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function attr(attrs: string, name: string): string {
  return decode(attrs.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? "");
}

/** 啟用請求:每個主物件一個 objectReference(只帶 uri 與 name) */
export function activationBody(objects: { uri: string; name: string }[]): string {
  const refs = objects
    .map((o) => `<adtcore:objectReference adtcore:uri="${xmlAttr(o.uri)}" adtcore:name="${xmlAttr(o.name.toUpperCase())}"/>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">${refs}</adtcore:objectReferences>`;
}

/**
 * 解析啟用回應(chkl:messages)。
 * 成功 = activationExecuted 不是 false,且沒有 E / A / X 訊息,且沒有回報仍為 inactive 的物件。
 */
export function parseActivationResponse(xml: string): ActivationResult {
  if (!xml.trim()) return { success: true, messages: [], inactive: [] };
  const props = xml.match(/<chkl:properties\b([^>]*)\/?>/)?.[1] ?? "";
  const messages: ActivationResultMessage[] = [...xml.matchAll(/<msg\b([^>]*)>([\s\S]*?)<\/msg>/g)].map((m) => ({
    objDescr: attr(m[1], "objDescr"),
    type: attr(m[1], "type"),
    line: Number(attr(m[1], "line")) || 0,
    href: attr(m[1], "href"),
    forceSupported: attr(m[1], "forceSupported") === "true",
    shortText: decode(m[2].match(/<txt>([\s\S]*?)<\/txt>/)?.[1] ?? "").trim(),
  }));
  const stillInactive = /<ioc:inactiveObjects\b[\s\S]*?<ioc:entry\b/.test(xml);
  const success =
    attr(props, "activationExecuted") !== "false" && !stillInactive && !messages.some((m) => /[EAX]/.test(m.type));
  return { success, messages, inactive: [] };
}
