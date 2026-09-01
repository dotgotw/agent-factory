import type { components } from '@af/contract';

type Project = components['schemas']['Project'];

/** 一次「就狀態異動通知負責人」要交付的內容。 */
export interface StatusChangeNotice {
  ownerEmail: string;
  projectId: string;
  projectName: string;
  from: Project['status'];
  to: Project['status'];
}

/**
 * 通知的寄送機制。
 *
 * contract 只講「通知這件事在外部看起來是什麼樣子」(Project.lastNotifiedAt),
 * 傳輸方式(SMTP / 第三方 / 佇列)不在契約範圍 —— 見
 * contract/decisions/ADR-004-observable-side-effects.md。這個介面就是那條
 * 分界線:路由只認得它,換傳輸方式時改的是本檔末的 binding,不是路由。
 */
export interface Notifier {
  /**
   * 交付一則通知。
   *
   * resolve 代表**已交付給寄送機制**,不代表對方收到了 —— lastNotifiedAt
   * 記的就是這個時刻,不多不少(ADR-004)。
   *
   * reject 代表沒交付出去。呼叫端不該因此讓 PATCH 失敗:改狀態是 API 的
   * 職責,通知是它的副作用,不是前提。
   */
  deliver(notice: StatusChangeNotice): Promise<void>;
}

/**
 * 寫一行 log 就算交付。
 *
 * 這個 repo 的 backend 目前是 in-memory、沒有任何外部依賴,通知不該是
 * 第一個 —— 真的要寄信時,實作一個新的 Notifier 換掉下面的 binding。
 *
 * 刻意不保留「寄過哪些」的清單:沒有東西讀得到它。要讓測試看得見通知,
 * 唯一的可觀察面是 lastNotifiedAt,ADR-004 已經否決了為測試而生的出口。
 */
export class ConsoleNotifier implements Notifier {
  async deliver(notice: StatusChangeNotice): Promise<void> {
    console.log(
      `[notify] ${notice.ownerEmail} ← 專案「${notice.projectName}」` +
        `(${notice.projectId}) ${notice.from} → ${notice.to}`,
    );
  }
}

/**
 * 本 app 使用的實作。型別標成 Notifier 而不是 ConsoleNotifier ——
 * 路由只看得到介面,換實作時不會有人已經偷偷依賴了記憶體版的細節。
 */
export const notifier: Notifier = new ConsoleNotifier();
