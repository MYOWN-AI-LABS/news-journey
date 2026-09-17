import { chromium, type Page } from "playwright";
import { publicResponse, safePublicUrl } from "./public-apis.js";

/** Source captures have no local network, credentials, service workers, or direct browser sockets. */
export async function withPublicPage<T>(url:string, read:(page:Page)=>Promise<T>):Promise<T> {
  const browser=await chromium.launch();
  const deadline=setTimeout(()=>{void browser.close();},30_000);
  try {
    const page=await browser.newPage({viewport:{width:1280,height:900},deviceScaleFactor:2,serviceWorkers:"block"});
    await page.context().routeWebSocket("**/*",socket=>socket.close());
    await page.context().route("**/*",async route=>{
      try {
        if(route.request().method()!=="GET")return await route.abort();
        const response=await publicResponse(safePublicUrl(route.request().url(),"Source capture"),{"User-Agent":"Content-Harness/0.2"},15_000);
        await route.fulfill({status:response.status,contentType:response.headers.get("content-type")??"application/octet-stream",body:Buffer.from(await response.arrayBuffer())});
      }catch{await route.abort();}
    });
    await page.goto(safePublicUrl(url,"Source page"),{waitUntil:"domcontentloaded",timeout:20_000});
    await page.waitForTimeout(1500);
    return await read(page);
  }finally{clearTimeout(deadline);await browser.close();}
}
