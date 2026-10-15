import { describe, expect, it } from "vitest";
import { localFontMenuGroups } from "./local-font-menu";
const face = (family: string) => ({ family,fullName:family,postscriptName:family,style:"Regular" });
const groups = [{id:"basic",label:"基本",options:[{label:"M PLUS 1p",value:'"M PLUS 1p", sans-serif'}]},
  {id:"windows",label:"Windows",options:[{label:"M-PRO",value:'"HG丸ｺﾞｼｯｸM-PRO", "HGMaruGothicMPRO", "Hiragino Sans", sans-serif'}]}];
describe("local font menu", () => {
  it("does not mistake an available fallback for the requested source font", () => {
    const result=localFontMenuGroups(groups,[face("Hiragino Sans")]);
    expect(result.flatMap(group=>group.options.map(option=>option.label))).toEqual(["M PLUS 1p","Hiragino Sans"]);
  });
  it("accepts source aliases and automatically discovers newly installed families", () => {
    const result=localFontMenuGroups(groups,[face("HGMaruGothicMPRO"),face("Example Font")]);
    expect(result.flatMap(group=>group.options.map(option=>option.label))).toEqual(["M PLUS 1p","M-PRO","Example Font"]);
    expect(result.at(-1)?.id).toBe("system");
    expect(localFontMenuGroups(groups,[]).flatMap(group=>group.options.map(option=>option.label))).toEqual(["M PLUS 1p"]);
  });
  it("keeps the static menu when the host reports the PC's fonts as unknown", () => {
    // An unreadable list is null, never []: an empty list would read as "nothing is installed" and empty the menu.
    expect(localFontMenuGroups(groups,null).flatMap(group=>group.options.map(option=>option.label))).toEqual(["M PLUS 1p","M-PRO"]);
  });
  it("preserves existing behavior when a host cannot enumerate fonts and escapes CSS family names", () => {
    expect(localFontMenuGroups(groups,null)).toBe(groups);
    const name='Font, "Quoted"';
    expect(localFontMenuGroups([],[face(name)])[0].options[0].value).toBe(JSON.stringify(name));
  });
});
