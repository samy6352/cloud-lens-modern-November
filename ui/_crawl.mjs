import { chromium } from "playwright";
import fs from "node:fs";
const base = "https://cloud-lens-web-scale-v2.azurewebsites.net";
const routes = ["/", "/explore/billing", "/explore/uptime", "/explore/tags", "/explore/resources", "/explore/anomalies", "/explore/history", "/explore/ai-billing",
  "/optimize/savings", "/optimize/commitments", "/optimize/performance", "/govern/budgets", "/govern/governance", "/govern/esu", "/govern/retirements", "/govern/changes",
  "/govern/azure-updates", "/reports/export", "/admin/setup", "/admin/cost-data", "/admin/audit"];
const out = [];
const b = await chromium.launch();
for (const [label, vp] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
  const ctx = await b.newContext({ viewport: vp });
  const page = await ctx.newPage();
  await page.goto(base + "/login?next=%2Fv2%2F", { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.locator("input[name=username]").fill("admin");
  await page.locator("input[name=password]").fill(process.env.CL_PW);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/v2/**", { timeout: 120000 });
  for (const r of routes) {
    const rec = { vp: label, route: r, console: [], pageerrors: [], failed: [], slow: [] };
    const onConsole = m => { if (["error", "warning"].includes(m.type())) rec.console.push(m.type() + ": " + m.text().slice(0, 240)); };
    const onErr = e => rec.pageerrors.push(String(e.message).slice(0, 240));
    const onResp = async resp => { const u = resp.url(); if (u.includes("/api/") && resp.status() >= 400) rec.failed.push(resp.status() + " " + new URL(u).pathname + new URL(u).search.slice(0, 80)); };
    page.on("console", onConsole); page.on("pageerror", onErr); page.on("response", onResp);
    const t0 = Date.now();
    try { await page.goto(base + "/v2" + (r === "/" ? "/" : r), { waitUntil: "domcontentloaded", timeout: 120000 }); await page.waitForTimeout(9000); } catch (e) { rec.pageerrors.push("nav: " + e.message.slice(0, 120)); }
    rec.ms = Date.now() - t0;
    rec.dom = await page.evaluate(() => {
      const de = document.documentElement;
      const text = document.body.innerText;
      const bad = [...text.matchAll(/(something went wrong|failed to|unexpected|undefined|NaN|\[object|could not|error)/gi)].map(m => m[0]).slice(0, 6);
      const wide = [...document.querySelectorAll("main *, #main *")].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 2 && !e.closest('[class*="overflow"]') && getComputedStyle(e).position !== "fixed"; }).slice(0, 4).map(e => e.tagName + "." + String(e.className).slice(0, 50));
      return { hOverflow: de.scrollWidth > de.clientWidth + 1, scrollW: de.scrollWidth, bad, wide, h1: (document.querySelector("h1")?.textContent || "").slice(0, 60), len: text.length };
    });
    await page.screenshot({ path: `D:/cloud lens v3/.shots/live/${label}-${r.replace(/\//g, "_") || "_"}.png`, fullPage: false });
    page.off("console", onConsole); page.off("pageerror", onErr); page.off("response", onResp);
    out.push(rec);
  }
  await ctx.close();
}
await b.close();
fs.writeFileSync("D:/cloud lens v3/.shots/live/report.json", JSON.stringify(out, null, 1));
console.log("done", out.length);
