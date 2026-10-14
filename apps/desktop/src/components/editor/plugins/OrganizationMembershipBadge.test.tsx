// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { setAppLocale } from "@/lib/i18n/react";
import { OrganizationMembershipBadge, OrganizationMembershipDisplay } from "./OrganizationMembershipBadge";
import type { OfficialPluginBridge, OfficialPluginStatus } from "./plugin-ui-contract";
let container: HTMLDivElement, root: Root;
const group={id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",name:"学校A",logoUrl:null};
const status:OfficialPluginStatus={available:true,requiresLogin:false,autoUpdate:true,phase:"idle",plugins:[],organizations:[group]};
beforeEach(()=>{(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;setAppLocale("ja");container=document.createElement("div");document.body.append(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();delete(window as Window & {sigmaPlugins?:OfficialPluginBridge}).sigmaPlugins;});
describe("organization membership display",()=>{
 it("shows the organization without a logo and accepts only host-provided raster data",async()=>{
  await act(async()=>root.render(<OrganizationMembershipDisplay organizations={[group]}/>));
  expect(container.textContent).toBe("学校A");expect(container.querySelector('[aria-label="学校Aに所属"]')).not.toBeNull();expect(container.querySelector("img")).toBeNull();
  await act(async()=>root.render(<OrganizationMembershipDisplay organizations={[{...group,logoUrl:"https://example.test/tracker.png"}]}/>));expect(container.querySelector("img")).toBeNull();
  await act(async()=>root.render(<OrganizationMembershipDisplay organizations={[{...group,logoUrl:"data:image/png;base64,AAAA"}]}/>));expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
 } );
 it("observes membership changes, hides on logout and ignores an older pending response",async()=>{
  let resolve!:(value:OfficialPluginStatus)=>void, listener!:(value:OfficialPluginStatus)=>void;
  const unsubscribe=vi.fn();const bridge:OfficialPluginBridge={check:async()=>status,install:async()=>status,setEnabled:async()=>status,setAutoUpdate:async()=>status,status:()=>new Promise<OfficialPluginStatus>(r=>{resolve=r;}),onChange:(fn:(value:OfficialPluginStatus)=>void)=>{listener=fn;return unsubscribe;}};
  (window as Window & {sigmaPlugins?:OfficialPluginBridge}).sigmaPlugins=bridge;
  await act(async()=>root.render(<OrganizationMembershipBadge/>));
  await act(async()=>listener(status));expect(container.textContent).toContain("学校A");
  await act(async()=>listener({...status,requiresLogin:true}));expect(container.textContent).toBe("");
  await act(async()=>resolve(status));expect(container.textContent).toBe("");
  await act(async()=>root.render(null));expect(unsubscribe).toHaveBeenCalledTimes(1);
 });
});
