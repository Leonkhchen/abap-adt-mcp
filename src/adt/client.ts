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
  type ClassComponent,
  type QueryResult,
  type DdicElement,
  type Revision,
} from "abap-adt-api";
import * as https from "node:https";
import type { AppConfig } from "../config.js";
import { assertAdtUri } from "../safety/uri.js";
import { AuthCircuitOpenError, hasHttpStatus, isAuthFailure } from "./errors.js";
import { activationBody, parseActivationResponse } from "./activation.js";
import {
  applyNamePrefix,
  findGeneratorLinks,
  parseObjectRefs,
  parseODataV4Service,
  parseValidationMessages,
  RAP_CONTENT_TYPE,
  RAP_PREVIEW_TYPE,
  RAP_UI_SERVICE_ID,
  type RapGeneratorLinks,
  type RapObjectRef,
} from "./rapGenerator.js";
import {
  extractDumpChapters,
  normalizeDumpId,
  parseDumpMeta,
  summarizeDump,
  type DumpMeta,
  type DumpSummary,
} from "./dumps.js";
import {
  parseUsageReferences,
  parseUsageSnippets,
  usageReferencesBody,
  usageSnippetsBody,
  type UsageObject,
  type UsageSnippet,
} from "./whereUsed.js";
import {
  baseObjectUrl,
  bdefCreateBody,
  packageUrl,
  parseValidation,
  TYPE_INFO,
  type CreatableType,
} from "./objectTypes.js";

/** ATC 單筆 finding(已攤平) */
export interface AtcFinding {
  objectName: string;
  priority: number;
  checkTitle: string;
  messageTitle: string;
  /** 位置 URI(含 #start=行,欄) */
  location: string;
  line: number;
}

export interface AtcResult {
  checkVariant: string;
  /** ATC 執行資訊,例如 TOOL_FAILURE(部分檢查無法執行)、FINDING_STATS */
  infos: { type: string; description: string }[];
  findings: AtcFinding[];
}

/** 資料元素 / domain 的屬性(abap-adt-api 回傳的 metaData + properties,保留原形狀) */
export interface DdicTypeProperties {
  metaData: { name: string; description?: string; packageName?: string };
  properties: object;
}

/** inactive 物件(或其子項目) */
export interface InactiveEntry {
  uri: string;
  type: string;
  name: string;
  /** 子項目(例如 class include)所屬物件的 URI;主物件為空字串 */
  parentUri: string;
  user: string;
  deleted: boolean;
}

/** find_definition 結果 */
export interface DefinitionResult {
  /** 查詢的識別字 */
  identifier: string;
  /** 定義所在的 source URI;找不到定義時為空字串 */
  url: string;
  /** 1 起算的行與欄 */
  line: number;
  column: number;
  /** 定義那一行的原始碼(讀取失敗時為空字串) */
  sourceLine: string;
}

/**
 * 找出某行第 column0 欄(0 起算)所在的 ABAP 識別字範圍。
 * ABAP 名稱可含 /(namespace)與 ~(介面元件,例如 if_x~method)。
 */
export function identifierAt(lineText: string, column0: number): { start: number; end: number; text: string } | undefined {
  const isId = (ch: string | undefined) => !!ch && /[A-Za-z0-9_\/~]/.test(ch);
  if (!isId(lineText[column0])) return undefined;
  let start = column0;
  let end = column0;
  while (isId(lineText[start - 1])) start--;
  while (isId(lineText[end])) end++;
  return { start, end, text: lineText.slice(start, end) };
}

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
  /**
   * 在鎖定用的 session(lockClient)讀取目前的原始碼(v0.5.1 C1):
   * 取得鎖定後、寫入前的權威比對用,與持有鎖定的是同一個 SAP session;呼叫前必須已 lock()。
   */
  getSourceInLock(sourceUrl: string): Promise<string>;
  setObjectSource(
    sourceUrl: string,
    source: string,
    lockHandle: string,
    transport?: string
  ): Promise<void>;
  lock(objectUrl: string): Promise<AdtLock>;
  /** 為 class 建立測試 include(/includes/testclasses);需在鎖定中呼叫 */
  createTestInclude(className: string, lockHandle: string, transport?: string): Promise<void>;
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
  /** 執行 ATC;checkVariant 省略時用系統預設(atcCustomizing 的 systemCheckVariant) */
  runAtc(url: string, checkVariant?: string, maxFindings?: number): Promise<AtcResult>;
  /**
   * where-used:url 為物件或 source URI;給 line/column0 時查該位置的元件(例如方法),
   * column0 是 ADT 的 0 起算欄位
   */
  whereUsed(url: string, line?: number, column0?: number): Promise<{ objects: UsageObject[]; snippets: UsageSnippet[] }>;
  /**
   * 跳到定義:sourceUrl 第 line 行(1 起算)、column0(0 起算)所在的識別字。
   * implementation=true 時跳到實作(例如方法的 METHOD 區塊)
   */
  findDefinition(sourceUrl: string, line: number, column0: number, implementation: boolean): Promise<DefinitionResult>;
  /** class / interface 的元件結構(方法、屬性、型別、實作的介面…) */
  classComponents(objectUrl: string): Promise<ClassComponent>;
  /** 執行 class 的 IF_OO_ADT_CLASSRUN~MAIN,回傳 out->write 的輸出 */
  runClass(className: string): Promise<string>;
  /** ADT discovery 是否有以 href 開頭的 collection(結果在 process 內快取) */
  hasAdtCollection(href: string): Promise<boolean>;
  /** abapGit ADT 後端的 repo 清單(呼叫前先用 hasAdtCollection 確認端點存在) */
  gitRepos(): Promise<{ name: string; packageName: string; url: string; branch: string; status: string }[]>;
  /** RAP ui-service 產生器的連結;系統沒有此產生器時回 undefined */
  rapGeneratorLinks(tableUri: string): Promise<RapGeneratorLinks | undefined>;
  /** 取得產生器預設內容(可套用名稱前綴)、檢查並預覽會建立的物件(不建立任何東西) */
  rapPreview(
    links: RapGeneratorLinks,
    tableUri: string,
    packageName: string,
    namePrefix?: string
  ): Promise<{ content: object; validation: { ok: boolean; messages: string[] }; objects: RapObjectRef[] }>;
  /** 依內容實際產生(transport 空字串 = 本機 package);回傳 SAP 回報的物件 */
  rapGenerate(links: RapGeneratorLinks, tableUri: string, content: object, transport: string): Promise<RapObjectRef[]>;
  /** 發佈 OData V4 service binding */
  rapPublish(bindingName: string): Promise<{ ok: boolean; message: string }>;
  /** service binding 的 OData V4 服務 URL 與主要 entity set */
  odataV4Service(bindingName: string): Promise<{ serviceUrl: string; leadingEntity: string }>;
  /** 版本歷史(新的在前);url 可為物件、source/main 或 class include */
  revisions(url: string): Promise<Revision[]>;
  /** 取得某個版本的內容;sourceUrl 是該物件(或 include)的 source URI */
  revisionContent(revisionUri: string, sourceUrl: string): Promise<string>;
  /** 目前 inactive 的物件(含子項目,例如 class 的 include);已過濾掉空紀錄 */
  inactiveObjects(): Promise<InactiveEntry[]>;
  /** 批次啟用(一次送出;呼叫端負責白名單檢查) */
  activateObjects(objects: InactiveEntry[]): Promise<ActivationResult>;
  /** 以系統的 Pretty Printer 設定格式化原始碼(只回傳結果,不寫入系統) */
  prettyPrint(source: string): Promise<{ source: string; style: string; indentation: boolean }>;
  /** ST22 短傾印列表(新的在前);user 指定時只列該使用者 */
  listDumps(user?: string): Promise<DumpSummary[]>;
  /** 單筆短傾印:metadata + 擷取後的章節文字(不含 Selected Variables 等可能含資料的章節) */
  dumpDetail(dumpId: string): Promise<{ meta: DumpMeta; text: string }>;
  /** DDIC 元素(表、CDS view 的欄位);結構與資料元素在 A4H 會回空 */
  ddicElement(name: string): Promise<DdicElement>;
  /** 資料元素屬性(型別、長度、欄位標籤) */
  dataElementProperties(url: string): Promise<DdicTypeProperties>;
  /** domain 屬性(型別、長度、固定值) */
  domainProperties(url: string): Promise<DdicTypeProperties>;
  /** 讀取單一表/view 的前 rows 筆(Data Preview);呼叫端負責白名單檢查 */
  tableContents(table: string, rows: number): Promise<QueryResult>;
  /** 執行自由 SELECT(Data Preview);呼叫端負責 SQL 與白名單檢查 */
  runQuery(sql: string, rows: number): Promise<QueryResult>;
  /** 建立 workbench transport request,回傳 TR 編號;refUrl 為相關物件(或 package)的 URI */
  createTransport(refUrl: string, description: string, packageName: string): Promise<string>;
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

/**
 * 只允許同 origin 的 redirect(v0.5.1 S1):axios 預設最多跟隨 5 次 redirect,
 * 若 SAP(或中間人)回 302 指向外部主機,帳密可能被帶出。
 * abap-adt-api 的 ClientOptions 不開放 maxRedirects/beforeRedirect,只能在建立後設到底層 axios。
 * 回傳是否成功安裝(底層結構變動時為 false,呼叫端記到 stderr)。
 */
export function restrictRedirectsToBaseOrigin(client: ADTClient, baseUrl: string): boolean {
  const axiosInstance = (
    client.httpClient as unknown as { httpclient?: { axios?: { defaults?: Record<string, unknown> } } }
  ).httpclient?.axios;
  if (!axiosInstance?.defaults) return false;
  const origin = new URL(baseUrl).origin;
  axiosInstance.defaults.beforeRedirect = (options: { protocol?: string; hostname?: string; host?: string; port?: string | number; href?: string }) => {
    const href = options.href ?? `${options.protocol ?? ""}//${options.host ?? options.hostname ?? ""}`;
    let target: string;
    try {
      target = new URL(href).origin;
    } catch {
      target = "(無法解析)";
    }
    if (target !== origin) {
      throw new Error(`拒絕跨 origin 的 redirect(${target}):為避免 SAP 帳密外送,只跟隨同一個 SAP 主機的 redirect。`);
    }
  };
  return true;
}

/** 連續認證失敗達此次數後斷路:不再連 SAP,避免重試把帳號鎖住(SAP 預設失敗 5 次即鎖定) */
export const MAX_AUTH_FAILURES = 2;

/**
 * 真實實作:包裝 abap-adt-api 的 ADTClient。
 *
 * 用兩個 ADTClient(兩個獨立的 SAP session):
 *  - client:一般呼叫(讀取、分析、啟用、建立、執行),一律 stateless
 *  - lockClient:只做 lock → setObjectSource / createTestInclude → unLock,鎖定期間為 stateful
 * 鎖定與寫入必須在同一個 stateful session;而 SAP 端只要一次例外就會結束該 session 的 context。
 * 分開後,其他工具在寫入鎖定期間並行執行、甚至出錯,也碰不到持有鎖定的 session。
 * 寫入類工具之間仍由 SerialQueue 依序執行。
 */
export class RealAdtService implements AdtService {
  private client: ADTClient;
  private lockClient: ADTClient;
  /** 連續認證失敗次數(兩個 client 共用);成功一次(或收到非認證類的 SAP 回應)即歸零 */
  private authFailures = 0;

  /**
   * @param client 選填:注入一般呼叫用的 ADTClient(單元測試用)
   * @param lockClient 選填:注入鎖定/寫入用的 ADTClient;只注入 client 時兩者共用
   */
  constructor(private cfg: AppConfig, client?: ADTClient, lockClient?: ADTClient) {
    const create = () => {
      const c = new ADTClient(
        cfg.sap.url,
        cfg.sap.user,
        cfg.sap.password,
        cfg.sap.client,
        cfg.sap.language,
        adtClientOptions(cfg)
      );
      if (!restrictRedirectsToBaseOrigin(c, cfg.sap.url)) {
        console.error("[abap-adt-mcp] 警告:無法限制 redirect 為同 origin(abap-adt-api 內部結構與預期不同)。");
      }
      return c;
    };
    this.client = client ?? create();
    this.lockClient = lockClient ?? (client ? client : create());
  }

  /**
   * 驗證「使用者給的 URI」只指向 /sap/bc/adt/ 底下(v0.5.1 S1,主要防線):
   * request 會帶 SAP 帳密,絕對 URL 或路徑穿越不可送出。必須在任何 HTTP 呼叫前執行。
   */
  private u(uri: string): string {
    return assertAdtUri(uri, this.cfg);
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
    const url = this.u(objectUrl);
    return this.guard(() => this.client.objectStructure(url));
  }

  mainInclude(structure: AbapObjectStructure): string {
    return ADTClient.mainInclude(structure);
  }

  /** objectStructure 不解析 package,直接讀物件 XML 的 adtcore:packageRef */
  async objectPackage(objectUrl: string) {
    const url = this.u(objectUrl);
    const response = await this.guard(() => this.client.httpClient.request(url));
    return packageFromObjectXml(String(response.body ?? ""));
  }

  async getObjectSource(sourceUrl: string) {
    const url = this.u(sourceUrl);
    return this.guard(() => this.client.getObjectSource(url));
  }

  async getSourceInLock(sourceUrl: string) {
    const url = this.u(sourceUrl);
    return this.guard(() => this.lockClient.getObjectSource(url));
  }

  async setObjectSource(
    sourceUrl: string,
    source: string,
    lockHandle: string,
    transport?: string
  ) {
    const url = this.u(sourceUrl);
    return this.guard(() => this.lockClient.setObjectSource(url, source, lockHandle, transport));
  }

  /**
   * 鎖定物件。
   * 重要:ADT 的 lock 需要 stateful session(cookie 維持同一 work process),
   * abap-adt-api 透過 client.stateful 切換,這裡集中處理。
   */
  async lock(objectUrl: string) {
    const url = this.u(objectUrl);
    return this.guard(async () => {
      this.lockClient.stateful = session_types.stateful;
      try {
        return await this.lockClient.lock(url);
      } catch (e) {
        // 鎖定失敗必須恢復 stateless:abap-adt-api 在 stateful 模式下不會自動重登,
        // 若停在 stateful,之後 session 失效時所有呼叫都無法恢復
        this.endStatefulSession();
        throw e;
      }
    });
  }

  /**
   * 回到 stateless,並丟掉 stateful 期間 SAP 發的 sap-contextid cookie。
   * A4H 實測:解鎖後若保留 sap-contextid,之後任何一次 SAP 端例外(例如讀取尚未建立的 include)
   * 會結束那個 context,此後所有請求都帶著失效的 context id 而回 400,且無法自行恢復。
   */
  private endStatefulSession(): void {
    this.lockClient.stateful = session_types.stateless;
    // AdtHTTP.cookie 在型別上是 private,執行期為 Map<cookie 名稱, 值>
    const jar = (this.lockClient.httpClient as unknown as { cookie?: Map<string, string> }).cookie;
    jar?.delete("sap-contextid");
  }

  async createTestInclude(className: string, lockHandle: string, transport?: string) {
    return this.guard(() => this.lockClient.createTestInclude(className.toUpperCase(), lockHandle, transport));
  }

  async unLock(objectUrl: string, lockHandle: string) {
    try {
      const url = this.u(objectUrl);
      await this.guard(() => this.lockClient.unLock(url, lockHandle));
    } finally {
      // 無論解鎖成敗(含斷路)都恢復 stateless,釋放後端資源並保留自動重登能力
      this.endStatefulSession();
    }
  }

  async activate(objectName: string, objectUrl: string) {
    const url = this.u(objectUrl);
    return this.guard(() => this.client.activate(objectName, url));
  }

  async syntaxCheck(url: string, mainUrl: string, content: string) {
    const u1 = this.u(url);
    const u2 = this.u(mainUrl);
    return this.guard(() => this.client.syntaxCheck(u1, u2, content));
  }

  async nodeContents(parentType: "DEVC/K", packageName: string) {
    return this.guard(() => this.client.nodeContents(parentType, packageName));
  }

  async transportInfo(objSourceUrl: string, devClass?: string) {
    const url = this.u(objSourceUrl);
    return this.guard(() => this.client.transportInfo(url, devClass));
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
    const safe = this.u(url);
    return this.guard(() => this.client.unitTestRun(safe, flags));
  }

  async runAtc(rawUrl: string, checkVariant?: string, maxFindings = 100) {
    const url = this.u(rawUrl);
    const variant =
      checkVariant ||
      String(
        (await this.guard(() => this.client.atcCustomizing())).properties.find(
          (p) => p.name === "systemCheckVariant"
        )?.value ?? ""
      );
    if (!variant) throw new Error("系統沒有設定預設 ATC check variant,請以 check_variant 參數指定。");
    // A4H 實測:系統啟動後第一次建立 worklist 可能超過 5 分鐘並回 500,但伺服器端已完成,重試一次即成功
    const worklistId = await this.guard(async () => {
      try {
        return await this.client.atcCheckVariant(variant);
      } catch (e) {
        const status = (e as { status?: unknown }).status;
        if (typeof status === "number" && status >= 500) return this.client.atcCheckVariant(variant);
        throw e;
      }
    });
    const run = await this.guard(() => this.client.createAtcRun(worklistId, url, maxFindings));
    const worklist = await this.guard(() => this.client.atcWorklists(run.id));
    const findings: AtcFinding[] = worklist.objects.flatMap((o) =>
      o.findings.map((f) => ({
        objectName: o.name,
        priority: f.priority,
        // SAP 的標題常帶尾端換行
        checkTitle: f.checkTitle.trim(),
        messageTitle: f.messageTitle.trim(),
        location: f.location.uri,
        line: f.location.range.start.line,
      }))
    );
    return { checkVariant: variant, infos: run.infos, findings };
  }

  async whereUsed(rawUrl: string, line?: number, column0?: number) {
    const url = this.u(rawUrl);
    const headers = { "Content-Type": "application/*", Accept: "application/*" };
    const uri = line ? `${url}#start=${line},${column0 ?? 0}` : url;
    const refs = await this.guard(() =>
      this.client.httpClient.request("/sap/bc/adt/repository/informationsystem/usageReferences", {
        method: "POST",
        qs: { uri },
        headers,
        body: usageReferencesBody(),
      })
    );
    const objects = parseUsageReferences(String(refs.body ?? ""));
    if (objects.length === 0) return { objects, snippets: [] };
    const snips = await this.guard(() =>
      this.client.httpClient.request("/sap/bc/adt/repository/informationsystem/usageSnippets", {
        method: "POST",
        headers,
        body: usageSnippetsBody(objects.map((o) => o.objectIdentifier)),
      })
    );
    return { objects, snippets: parseUsageSnippets(String(snips.body ?? "")) };
  }

  async findDefinition(rawSourceUrl: string, line: number, column0: number, implementation: boolean) {
    const sourceUrl = this.u(rawSourceUrl);
    const source = await this.guard(() => this.client.getObjectSource(sourceUrl));
    const lines = source.split(/\r?\n/);
    const lineText = lines[line - 1];
    if (lineText === undefined) throw new Error(`第 ${line} 行不存在(原始碼共 ${lines.length} 行)。`);
    const id = identifierAt(lineText, column0);
    if (!id) {
      throw new Error(`第 ${line} 行第 ${column0 + 1} 欄不是識別字:「${lineText.trim()}」。請把 column 指到名稱上。`);
    }
    // mainProgram:include(例如 testclasses)需告知所屬主程式,一律用物件的 main source
    const mainProgram = sourceUrl.replace(/\/(source\/[^/]+|includes\/[^/]+)$/, "") + "/source/main";
    const loc = await this.guard(() =>
      this.client.findDefinition(sourceUrl, source, line, id.start, id.end, implementation, mainProgram)
    );
    if (!loc.url) return { identifier: id.text, url: "", line: 0, column: 0, sourceLine: "" };
    let sourceLine = "";
    try {
      const target = loc.url === sourceUrl ? source : await this.guard(() => this.client.getObjectSource(this.u(loc.url)));
      sourceLine = target.split(/\r?\n/)[loc.line - 1] ?? "";
    } catch {
      // 讀不到目標原始碼(例如權限)時只回位置
    }
    return { identifier: id.text, url: loc.url, line: loc.line, column: loc.column + 1, sourceLine };
  }

  async classComponents(objectUrl: string) {
    const url = this.u(objectUrl);
    return this.guard(() => this.client.classComponents(url));
  }

  async runClass(className: string) {
    return this.guard(() => this.client.runClass(className.toUpperCase()));
  }

  /** ADT discovery 的 collection href 清單(第一次讀取後快取;約 400 KB) */
  private discoveryHrefs?: Promise<string[]>;

  async hasAdtCollection(href: string) {
    this.discoveryHrefs ??= this.guard(() =>
      this.client.httpClient.request("/sap/bc/adt/discovery", { headers: { Accept: "application/atomsvc+xml" } })
    )
      .then((r) => [...String(r.body ?? "").matchAll(/<app:collection\s+href="([^"]+)"/g)].map((m) => m[1]))
      .catch((e) => {
        this.discoveryHrefs = undefined; // 失敗不快取,下次重試
        throw e;
      });
    return (await this.discoveryHrefs).some((h) => h === href || h.startsWith(`${href}/`));
  }

  async gitRepos() {
    const repos = await this.guard(() => this.client.gitRepos());
    return repos.map((r) => ({
      name: (r.url ?? "").replace(/\/$/, "").split("/").pop()?.replace(/\.git$/, "") ?? "",
      packageName: r.sapPackage ?? "",
      url: r.url ?? "",
      branch: r.branch_name ?? "",
      status: r.status_text ?? r.status ?? "",
    }));
  }

  async rapGeneratorLinks(tableUri: string) {
    this.u(tableUri);
    const feed = await this.guard(() =>
      this.client.httpClient.request(
        `/sap/bc/adt/repository/generators?referencedObject=${encodeURIComponent(tableUri)}&fetchAllGenerators=true`,
        { headers: { Accept: "application/atom+xml;type=feed" } }
      )
    );
    return findGeneratorLinks(String(feed.body ?? ""), RAP_UI_SERVICE_ID);
  }

  async rapPreview(links: RapGeneratorLinks, tableUri: string, packageName: string, namePrefix?: string) {
    this.u(tableUri);
    this.u(links.content);
    this.u(links.validation);
    this.u(links.preview);
    const ref = `referencedObject=${encodeURIComponent(tableUri)}`;
    const raw = await this.guard(() =>
      this.client.httpClient.request(`${links.content}?${ref}&package=${encodeURIComponent(packageName.toUpperCase())}`, {
        headers: { Accept: RAP_CONTENT_TYPE },
      })
    );
    let content = JSON.parse(String(raw.body)) as object;
    if (namePrefix) content = applyNamePrefix(content, namePrefix.toUpperCase());
    const body = JSON.stringify(content);
    const v = await this.guard(() =>
      this.client.httpClient.request(`${links.validation}?${ref}`, {
        method: "POST",
        headers: { "Content-Type": RAP_CONTENT_TYPE },
        body,
      })
    );
    const p = await this.guard(() =>
      this.client.httpClient.request(`${links.preview}?${ref}`, {
        method: "POST",
        headers: { "Content-Type": RAP_CONTENT_TYPE, Accept: RAP_PREVIEW_TYPE },
        body,
      })
    );
    return {
      content,
      validation: parseValidationMessages(String(v.body ?? "")),
      objects: parseObjectRefs(String(p.body ?? "")),
    };
  }

  async rapGenerate(links: RapGeneratorLinks, tableUri: string, content: object, transport: string) {
    this.u(tableUri);
    this.u(links.generator);
    // corrNr 一定要帶(本機 package 為空字串);走寫入用的獨立 session(呼叫端另經寫入佇列)
    const r = await this.guard(() =>
      this.lockClient.httpClient.request(
        `${links.generator}?referencedObject=${encodeURIComponent(tableUri)}&corrNr=${encodeURIComponent(transport)}`,
        { method: "POST", headers: { "Content-Type": RAP_CONTENT_TYPE, Accept: "*/*" }, body: JSON.stringify(content) }
      )
    );
    return parseObjectRefs(String(r.body ?? ""));
  }

  async rapPublish(bindingName: string) {
    const name = bindingName.toUpperCase().replace(/[^A-Z0-9_/]/g, "");
    const r = await this.guard(() =>
      this.lockClient.httpClient.request("/sap/bc/adt/businessservices/odatav4/publishjobs", {
        method: "POST",
        headers: {
          "Content-Type": "application/xml",
          Accept: "application/xml, application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.StatusMessage",
        },
        body:
          `<?xml version="1.0" encoding="UTF-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">` +
          `<adtcore:objectReference adtcore:type="SCGR" adtcore:name="${name}"/></adtcore:objectReferences>`,
      })
    );
    const x = String(r.body ?? "");
    const severity = (x.match(/<SEVERITY>([^<]*)<\/SEVERITY>/)?.[1] ?? "").toUpperCase();
    return { ok: severity === "OK" || severity === "", message: x.match(/<SHORT_TEXT>([^<]*)<\/SHORT_TEXT>/)?.[1] ?? "" };
  }

  async odataV4Service(bindingName: string) {
    const n = encodeURIComponent(bindingName.toUpperCase());
    const r = await this.guard(() =>
      this.client.httpClient.request(
        `/sap/bc/adt/businessservices/odatav4/${n}?servicename=${n}&serviceversion=0001&srvdname=${n}`,
        { headers: { Accept: "application/vnd.sap.adt.businessservices.odatav4.v2+xml" } }
      )
    );
    return parseODataV4Service(String(r.body ?? ""));
  }

  async revisions(rawUrl: string) {
    const url = this.u(rawUrl);
    // class include(…/includes/testclasses)要以 class + include 名稱查詢
    const inc = url.match(/^(.*\/oo\/classes\/[^/]+)\/includes\/([^/]+)$/);
    const list = inc
      ? await this.guard(() => this.client.revisions(inc[1], inc[2] as never))
      : await this.guard(() => this.client.revisions(baseObjectUrl(url)));
    return [...list].sort((a, b) => b.date.localeCompare(a.date));
  }

  async revisionContent(rawRevisionUri: string, rawSourceUrl: string) {
    const revisionUri = this.u(rawRevisionUri);
    const sourceUrl = this.u(rawSourceUrl);
    const m = revisionUri.match(/^\/sap\/bc\/adt\/.+\/versions\/[^/]+\/([^/]+)\/content$/);
    if (!m) throw new Error("版本 URI 格式不正確:必須是 get_revisions 回傳的 …/versions/…/content。");
    // A4H 實測:class 的版本內容(includes/main/versions/…)排版與 source/main 不同,且剛寫入後偶爾讀到舊內容;
    // active(00000)/ inactive(99999)直接以 source URI + version 讀取,與 read_source 看到的一致
    if (m[1] === "00000") return this.guard(() => this.client.getObjectSource(sourceUrl, { version: "active" }));
    if (m[1] === "99999") return this.guard(() => this.client.getObjectSource(sourceUrl, { version: "inactive" }));
    return this.guard(() => this.client.getObjectSource(revisionUri));
  }

  async inactiveObjects() {
    const records = await this.guard(() => this.client.inactiveObjects());
    // A4H 實測:清單裡有沒有 object 的空紀錄(只有 transport 或什麼都沒有)
    return records
      .filter((r) => r.object)
      .map((r) => ({
        uri: r.object!["adtcore:uri"],
        type: r.object!["adtcore:type"],
        name: r.object!["adtcore:name"],
        parentUri: r.object!["adtcore:parentUri"] ?? "",
        user: r.object!.user ?? "",
        deleted: !!r.object!.deleted,
      }));
  }

  async activateObjects(objects: InactiveEntry[]) {
    // 只送主物件(子項目會隨主物件一起啟用);請求形狀見 adt/activation.ts(A4H 實測)
    const mains = new Map<string, string>();
    for (const o of objects) {
      this.u(o.parentUri || o.uri);
      // 子項目(例如 class include)的 name 與所屬物件相同;主物件的紀錄優先
      const uri = o.parentUri || o.uri;
      if (!o.parentUri || !mains.has(uri)) mains.set(uri, o.name);
    }
    const body = activationBody([...mains].map(([uri, name]) => ({ uri, name })));
    // 走寫入用的獨立 session(呼叫端另經寫入佇列依序執行),與讀取類工具互不干擾
    const response = await this.guard(() =>
      this.lockClient.httpClient.request("/sap/bc/adt/activation", {
        method: "POST",
        qs: { method: "activate", preauditRequested: true },
        body,
        headers: { Accept: "application/xml", "Content-Type": "application/xml" },
      })
    );
    return parseActivationResponse(String(response.body ?? ""));
  }

  async prettyPrint(source: string) {
    const settings = await this.guard(() => this.client.prettyPrinterSetting());
    const formatted = await this.guard(() => this.client.prettyPrinter(source));
    return {
      source: formatted,
      style: String(settings["abapformatter:style"] ?? ""),
      indentation: !!settings["abapformatter:indentation"],
    };
  }

  async listDumps(user?: string) {
    // A4H 實測:$query 支援 and( equals( user, X ) );日期條件的格式不被接受,改由呼叫端依 id 的時間戳篩選
    const query = user ? `and( equals( user, ${user.toUpperCase().replace(/[^A-Z0-9_]/g, "")} ) )` : "";
    const feed = await this.guard(() => this.client.dumps(query));
    return feed.dumps.map(summarizeDump).sort((a, b) => b.datetime.localeCompare(a.datetime));
  }

  async dumpDetail(dumpId: string) {
    const id = normalizeDumpId(dumpId);
    const xml = await this.guard(() =>
      this.client.httpClient.request(id, { headers: { Accept: "application/vnd.sap.adt.runtime.dump.v1+xml" } })
    );
    const meta = parseDumpMeta(String(xml.body ?? ""));
    if (!meta.contentsUri) return { meta, text: "" };
    const contentsUri = this.u(meta.contentsUri);
    const body = await this.guard(() =>
      this.client.httpClient.request(contentsUri, { headers: { Accept: "text/plain" } })
    );
    return { meta, text: extractDumpChapters(String(body.body ?? ""), meta.chapters) };
  }

  async ddicElement(name: string) {
    return this.guard(() => this.client.ddicElement(name));
  }

  async dataElementProperties(url: string) {
    return this.guard(() => this.client.getDataElementProperties(url)) as Promise<DdicTypeProperties>;
  }

  async domainProperties(url: string) {
    return this.guard(() => this.client.getDomainProperties(url)) as Promise<DdicTypeProperties>;
  }

  async tableContents(table: string, rows: number) {
    return this.guard(() => this.client.tableContents(table, rows));
  }

  async runQuery(sql: string, rows: number) {
    return this.guard(() => this.client.runQuery(sql, rows));
  }

  async createTransport(refUrl: string, description: string, packageName: string) {
    const ref = this.u(refUrl);
    return this.guard(() => this.client.createTransport(ref, description, packageName.toUpperCase()));
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
