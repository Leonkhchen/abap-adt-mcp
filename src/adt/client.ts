/**
 * adt/client.ts — ADT 存取層
 *
 * 將 abap-adt-api 的 ADTClient 包裝在 AdtService 介面之後:
 *  1. 單元測試可以 mock 整個介面,不需要真實 SAP 系統
 *  2. 未來若需更換底層 library(或自行實作 REST 呼叫),只動這一層
 *  3. 集中處理登入、stateful session 切換等細節
 */
import {
  ADTClient,
  session_types,
  type AbapObjectStructure,
  type ActivationResult,
  type AdtLock,
  type ClientOptions,
  type NodeStructure,
  type SearchResult,
  type SyntaxCheckResult,
  type TransportInfo,
  type TransportsOfUser,
  type UnitTestClass,
} from "abap-adt-api";
import * as https from "node:https";
import type { AppConfig } from "../config.js";
import { AuthCircuitOpenError, hasHttpStatus, isAuthFailure } from "./errors.js";
import {
  bdefCreateBody,
  packageUrl,
  parseValidation,
  TYPE_INFO,
  type CreatableType,
} from "./objectTypes.js";

/** 建立物件的參數 */
export interface NewObjectSpec {
  type: CreatableType;
  name: string;
  packageName: string;
  description: string;
}

/** MCP 工具層所依賴的 ADT 操作介面(僅暴露 MVP 需要的方法) */
export interface AdtService {
  login(): Promise<void>;
  /** 每次都實際對 SAP 發一次請求(不依賴快取的登入狀態),回傳耗時 */
  ping(): Promise<{ elapsedMs: number }>;
  searchObject(query: string, objType?: string, max?: number): Promise<SearchResult[]>;
  objectStructure(objectUrl: string): Promise<AbapObjectStructure>;
  /** 取得物件所在的 package 名稱(大寫);找不到時回傳空字串 */
  objectPackage(objectUrl: string): Promise<string>;
  /** 由物件結構推導主要 include 的 source URL */
  mainInclude(structure: AbapObjectStructure): string;
  getObjectSource(sourceUrl: string): Promise<string>;
  setObjectSource(
    sourceUrl: string,
    source: string,
    lockHandle: string,
    transport?: string
  ): Promise<void>;
  lock(objectUrl: string): Promise<AdtLock>;
  unLock(objectUrl: string, lockHandle: string): Promise<void>;
  activate(objectName: string, objectUrl: string): Promise<ActivationResult>;
  syntaxCheck(
    url: string,
    mainUrl: string,
    content: string
  ): Promise<SyntaxCheckResult[]>;
  nodeContents(parentType: "DEVC/K", packageName: string): Promise<NodeStructure>;
  transportInfo(objSourceUrl: string, devClass?: string): Promise<TransportInfo>;
  userTransports(user: string): Promise<TransportsOfUser>;
  /** 建立前檢查名稱是否可用;不可用時回傳 ok=false 與 SAP 的說明 */
  validateNewObject(o: NewObjectSpec): Promise<{ ok: boolean; message: string }>;
  /** 建立新物件(只建立空殼;原始碼另以 write_source 寫入) */
  createObject(o: NewObjectSpec & { transport?: string }): Promise<void>;
  /** 執行 ABAP Unit(物件或 package URI);只跑 RISK LEVEL HARMLESS 的測試 */
  runUnitTests(url: string): Promise<UnitTestClass[]>;
  /** 取得目前登入的使用者帳號 */
  username(): string;
  /** 取得系統 base URL(供診斷訊息使用) */
  baseUrl(): string;
}

/**
 * ADTClient 的連線選項。
 * 自簽憑證支援:內網開發系統常見自簽憑證,需明確開啟才放行(見 SECURITY.md)。
 * 只對 ADTClient 自己的 https.Agent 停用驗證,不影響同一 process 的其他連線。
 */
export function adtClientOptions(cfg: AppConfig): ClientOptions {
  return cfg.sap.allowSelfSigned
    ? { httpsAgent: new https.Agent({ rejectUnauthorized: false }) }
    : {};
}

/** 從 ADT 物件 XML 取出 adtcore:packageRef 的 package 名稱 */
export function packageFromObjectXml(xml: string): string {
  const m = xml.match(/<adtcore:packageRef\b[^>]*\badtcore:name="([^"]*)"/);
  return m ? m[1].toUpperCase() : "";
}

/** 連續認證失敗達此次數後斷路:不再連 SAP,避免重試把帳號鎖住(SAP 預設失敗 5 次即鎖定) */
export const MAX_AUTH_FAILURES = 2;

/** 真實實作:包裝 abap-adt-api 的 ADTClient */
export class RealAdtService implements AdtService {
  private client: ADTClient;
  /** 連續認證失敗次數;成功一次(或收到非認證類的 SAP 回應)即歸零 */
  private authFailures = 0;

  /** @param client 選填:注入既有的 ADTClient(單元測試用) */
  constructor(private cfg: AppConfig, client?: ADTClient) {
    this.client =
      client ??
      new ADTClient(
        cfg.sap.url,
        cfg.sap.user,
        cfg.sap.password,
        cfg.sap.client,
        cfg.sap.language,
        adtClientOptions(cfg)
      );
  }

  /**
   * 所有連 SAP 的呼叫都經過這裡(401 斷路器)。
   * 連續 MAX_AUTH_FAILURES 次認證失敗後,之後的呼叫直接拋出 AuthCircuitOpenError、不再連線;
   * 要恢復必須修正密碼後重開 MCP(密碼只在啟動時讀取,重試也不會變對)。
   */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    if (this.authFailures >= MAX_AUTH_FAILURES) {
      throw new AuthCircuitOpenError(this.authFailures);
    }
    try {
      const result = await fn();
      this.authFailures = 0;
      return result;
    } catch (e) {
      if (isAuthFailure(e)) {
        this.authFailures++;
      } else if (hasHttpStatus(e)) {
        // SAP 有回應且不是認證問題(例如 404):代表帳密是對的
        this.authFailures = 0;
      }
      // 網路層錯誤(SAP 未啟動等)無法判斷帳密,不改變計數
      throw e;
    }
  }

  /**
   * 確保已登入(冪等)。登入狀態以 abap-adt-api 的 ADTClient.loggedin 為準,
   * 不另外快取:其 request() 在未登入時會自動登入,stateless 下遇 401 也會自動重登一次,
   * 因此一般方法不需要先呼叫 login()。
   */
  async login(): Promise<void> {
    await this.guard(async () => {
      if (!this.client.loggedin) await this.client.login();
    });
  }

  /**
   * 連線測試:走 abap-adt-api 的 request()(未登入會自動登入,
   * stateless 下遇 401 會自動重登一次),確保每次 ping 都真的連到 SAP。
   */
  async ping() {
    const start = Date.now();
    await this.guard(() => this.client.httpClient.request("/sap/bc/adt/compatibility/graph"));
    return { elapsedMs: Date.now() - start };
  }

  username(): string {
    return this.cfg.sap.user;
  }

  baseUrl(): string {
    return this.cfg.sap.url;
  }

  async searchObject(query: string, objType?: string, max?: number) {
    return this.guard(() => this.client.searchObject(query, objType, max));
  }

  async objectStructure(objectUrl: string) {
    return this.guard(() => this.client.objectStructure(objectUrl));
  }

  mainInclude(structure: AbapObjectStructure): string {
    return ADTClient.mainInclude(structure);
  }

  /** objectStructure 不解析 package,直接讀物件 XML 的 adtcore:packageRef */
  async objectPackage(objectUrl: string) {
    const response = await this.guard(() => this.client.httpClient.request(objectUrl));
    return packageFromObjectXml(String(response.body ?? ""));
  }

  async getObjectSource(sourceUrl: string) {
    return this.guard(() => this.client.getObjectSource(sourceUrl));
  }

  async setObjectSource(
    sourceUrl: string,
    source: string,
    lockHandle: string,
    transport?: string
  ) {
    return this.guard(() => this.client.setObjectSource(sourceUrl, source, lockHandle, transport));
  }

  /**
   * 鎖定物件。
   * 重要:ADT 的 lock 需要 stateful session(cookie 維持同一 work process),
   * abap-adt-api 透過 client.stateful 切換,這裡集中處理。
   */
  async lock(objectUrl: string) {
    return this.guard(async () => {
      this.client.stateful = session_types.stateful;
      try {
        return await this.client.lock(objectUrl);
      } catch (e) {
        // 鎖定失敗必須恢復 stateless:abap-adt-api 在 stateful 模式下不會自動重登,
        // 若停在 stateful,之後 session 失效時所有呼叫都無法恢復
        this.client.stateful = session_types.stateless;
        throw e;
      }
    });
  }

  async unLock(objectUrl: string, lockHandle: string) {
    try {
      await this.guard(() => this.client.unLock(objectUrl, lockHandle));
    } finally {
      // 無論解鎖成敗(含斷路)都恢復 stateless,釋放後端資源並保留自動重登能力
      this.client.stateful = session_types.stateless;
    }
  }

  async activate(objectName: string, objectUrl: string) {
    return this.guard(() => this.client.activate(objectName, objectUrl));
  }

  async syntaxCheck(url: string, mainUrl: string, content: string) {
    return this.guard(() => this.client.syntaxCheck(url, mainUrl, content));
  }

  async nodeContents(parentType: "DEVC/K", packageName: string) {
    return this.guard(() => this.client.nodeContents(parentType, packageName));
  }

  async transportInfo(objSourceUrl: string, devClass?: string) {
    return this.guard(() => this.client.transportInfo(objSourceUrl, devClass));
  }

  async userTransports(user: string) {
    return this.guard(() => this.client.userTransports(user));
  }

  async validateNewObject(o: NewObjectSpec) {
    if (o.type === "BDEF/BDO") {
      // abap-adt-api 不支援 BDEF;validation 端點以 HTTP 200 + SEVERITY 回報結果
      const response = await this.guard(() =>
        this.client.httpClient.request("/sap/bc/adt/bo/behaviordefinitions/validation", {
          method: "POST",
          qs: { objname: o.name.toUpperCase(), description: o.description, packagename: o.packageName.toUpperCase() },
        })
      );
      const v = parseValidation(String(response.body ?? ""));
      return { ok: v.severity !== "ERROR", message: v.text };
    }
    try {
      await this.guard(() =>
        this.client.validateNewObject({
          objtype: o.type as Exclude<CreatableType, "BDEF/BDO">,
          objname: o.name.toUpperCase(),
          packagename: o.packageName.toUpperCase(),
          description: o.description,
        })
      );
      return { ok: true, message: "" };
    } catch (e) {
      // abap-adt-api 在 SEVERITY=ERROR 時丟出 adtException(無 HTTP 狀態碼),訊息即 SAP 的說明
      if (!hasHttpStatus(e) && e instanceof Error && e.message && !isAuthFailure(e)) {
        return { ok: false, message: e.message };
      }
      throw e;
    }
  }

  async runUnitTests(url: string) {
    // 單元測試會執行程式:只跑 harmless(不改資料庫/系統設定);duration 不含 long
    const flags = { harmless: true, dangerous: false, critical: false, short: true, medium: true, long: false };
    return this.guard(() => this.client.unitTestRun(url, flags));
  }

  async createObject(o: NewObjectSpec & { transport?: string }) {
    const responsible = this.cfg.sap.user.toUpperCase();
    if (o.type === "BDEF/BDO") {
      await this.guard(() =>
        this.client.httpClient.request(TYPE_INFO["BDEF/BDO"].collection, {
          method: "POST",
          body: bdefCreateBody({
            name: o.name,
            packageName: o.packageName,
            description: o.description,
            responsible,
            language: this.cfg.sap.language || "EN",
          }),
          headers: { "Content-Type": "application/vnd.sap.adt.blues.v1+xml" },
          qs: o.transport ? { corrNr: o.transport } : {},
        })
      );
      return;
    }
    await this.guard(() =>
      this.client.createObject({
        objtype: o.type as Exclude<CreatableType, "BDEF/BDO">,
        name: o.name.toUpperCase(),
        parentName: o.packageName.toUpperCase(),
        description: o.description,
        parentPath: packageUrl(o.packageName),
        responsible,
        transport: o.transport,
      })
    );
  }
}
