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
  type NodeStructure,
  type SearchResult,
  type SyntaxCheckResult,
  type TransportInfo,
  type TransportsOfUser,
} from "abap-adt-api";
import type { AppConfig } from "../config.js";

/** MCP 工具層所依賴的 ADT 操作介面(僅暴露 MVP 需要的方法) */
export interface AdtService {
  login(): Promise<void>;
  searchObject(query: string, objType?: string, max?: number): Promise<SearchResult[]>;
  objectStructure(objectUrl: string): Promise<AbapObjectStructure>;
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
  /** 取得目前登入的使用者帳號 */
  username(): string;
  /** 取得系統 base URL(供診斷訊息使用) */
  baseUrl(): string;
}

/** 真實實作:包裝 abap-adt-api 的 ADTClient */
export class RealAdtService implements AdtService {
  private client: ADTClient;
  private loggedIn = false;

  constructor(private cfg: AppConfig) {
    // 自簽憑證支援:abap-adt-api 底層使用 Node fetch/https,
    // 在內網開發系統常見自簽憑證,需明確開啟才放行(見 SECURITY.md)
    if (cfg.sap.allowSelfSigned) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }
    this.client = new ADTClient(
      cfg.sap.url,
      cfg.sap.user,
      cfg.sap.password,
      cfg.sap.client,
      cfg.sap.language
    );
  }

  /** 確保已登入(冪等;斷線後可重複呼叫) */
  async login(): Promise<void> {
    if (!this.loggedIn) {
      await this.client.login();
      this.loggedIn = true;
    }
  }

  username(): string {
    return this.cfg.sap.user;
  }

  baseUrl(): string {
    return this.cfg.sap.url;
  }

  async searchObject(query: string, objType?: string, max?: number) {
    await this.login();
    return this.client.searchObject(query, objType, max);
  }

  async objectStructure(objectUrl: string) {
    await this.login();
    return this.client.objectStructure(objectUrl);
  }

  mainInclude(structure: AbapObjectStructure): string {
    return ADTClient.mainInclude(structure);
  }

  async getObjectSource(sourceUrl: string) {
    await this.login();
    return this.client.getObjectSource(sourceUrl);
  }

  async setObjectSource(
    sourceUrl: string,
    source: string,
    lockHandle: string,
    transport?: string
  ) {
    await this.login();
    return this.client.setObjectSource(sourceUrl, source, lockHandle, transport);
  }

  /**
   * 鎖定物件。
   * 重要:ADT 的 lock 需要 stateful session(cookie 維持同一 work process),
   * abap-adt-api 透過 client.stateful 切換,這裡集中處理。
   */
  async lock(objectUrl: string) {
    await this.login();
    this.client.stateful = session_types.stateful;
    return this.client.lock(objectUrl);
  }

  async unLock(objectUrl: string, lockHandle: string) {
    await this.client.unLock(objectUrl, lockHandle);
    // 解鎖後恢復 stateless,釋放後端資源
    this.client.stateful = session_types.stateless;
  }

  async activate(objectName: string, objectUrl: string) {
    await this.login();
    return this.client.activate(objectName, objectUrl);
  }

  async syntaxCheck(url: string, mainUrl: string, content: string) {
    await this.login();
    return this.client.syntaxCheck(url, mainUrl, content);
  }

  async nodeContents(parentType: "DEVC/K", packageName: string) {
    await this.login();
    return this.client.nodeContents(parentType, packageName);
  }

  async transportInfo(objSourceUrl: string, devClass?: string) {
    await this.login();
    return this.client.transportInfo(objSourceUrl, devClass);
  }

  async userTransports(user: string) {
    await this.login();
    return this.client.userTransports(user);
  }
}
