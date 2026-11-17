// 电视端内置拼音输入的纯逻辑测试（utils/pinyinInput.ts）。
import {
  getCandidates,
  isValidSyllable,
  isSyllablePrefix,
  appendLetter,
  selectCandidate,
  commitFirstCandidate,
} from "../pinyinInput";

describe("getCandidates（拼音 → 候选字）", () => {
  it("常用音节首选是常用字", () => {
    expect(getCandidates("zhong")[0]).toBe("中");
    expect(getCandidates("guo")[0]).toBe("国");
    expect(getCandidates("dian")[0]).toBe("点");
    expect(getCandidates("yi")[0]).toBe("一");
    expect(getCandidates("shi")[0]).toBe("是");
    expect(getCandidates("jie")[0]).toBe("接");
  });

  it("ü 用 v 表示（nv=女、lv=绿）", () => {
    expect(getCandidates("nv")[0]).toBe("女");
    expect(getCandidates("lv")[0]).toBe("绿");
  });

  it("生僻读音不混进候选前排：家不在 jie 里、她不在 jie 里", () => {
    expect(getCandidates("jie")).not.toContain("家");
    expect(getCandidates("jie")).not.toContain("她");
    expect(getCandidates("jia")[0]).toBe("家");
    expect(getCandidates("ta")).toContain("她");
  });

  it("多音字的次常用读音仍能找到（行在 hang 和 xing 里都有）", () => {
    expect(getCandidates("xing")).toContain("行");
    expect(getCandidates("hang")).toContain("行");
    expect(getCandidates("chang")).toContain("长");
  });

  it("非法拼音返回空数组", () => {
    expect(getCandidates("")).toEqual([]);
    expect(getCandidates("zx")).toEqual([]);
    expect(getCandidates("zhongguo")).toEqual([]);
  });
});

describe("isValidSyllable / isSyllablePrefix", () => {
  it("完整音节与前缀能区分", () => {
    expect(isValidSyllable("zhong")).toBe(true);
    expect(isValidSyllable("zh")).toBe(false);
    expect(isSyllablePrefix("zh")).toBe(true);
    expect(isSyllablePrefix("zho")).toBe(true);
    expect(isSyllablePrefix("zhong")).toBe(false);
    expect(isSyllablePrefix("zx")).toBe(false);
  });
});

describe("appendLetter（边打边拼）", () => {
  it("合法音节直接收下", () => {
    expect(appendLetter("", "j")).toEqual({ buffer: "j", commit: null });
    expect(appendLetter("j", "i")).toEqual({ buffer: "ji", commit: null });
    expect(appendLetter("ji", "e")).toEqual({ buffer: "jie", commit: null });
  });

  it("连续拼词：旧音节合法时，新字母一来先把首选字上屏", () => {
    // 打 zhong 再打 g：g 不能接在 zhong 后面，先把“中”上屏，再用 g 开新音节
    expect(appendLetter("zhong", "g")).toEqual({ buffer: "g", commit: "中" });
    // 打 ai 再打 r：同理，先把“爱”上屏
    expect(appendLetter("ai", "r")).toEqual({ buffer: "r", commit: "爱" });
  });

  it("合法音节还能往长里拼时不提前上屏（zha + n = zhan）", () => {
    expect(appendLetter("zha", "n")).toEqual({ buffer: "zhan", commit: null });
  });

  it("误输的非法缓冲被新字母重开", () => {
    expect(appendLetter("zx", "j")).toEqual({ buffer: "j", commit: null });
  });
});

describe("selectCandidate / commitFirstCandidate", () => {
  it("按下标取候选字，越界返回 null", () => {
    expect(selectCandidate("jie", 0)).toBe("接");
    expect(selectCandidate("jie", 1)).toBe("街");
    expect(selectCandidate("jie", 999)).toBeNull();
    expect(selectCandidate("zx", 0)).toBeNull();
  });

  it("空格语义：合法音节返回首选字，否则返回 null", () => {
    expect(commitFirstCandidate("jie")).toBe("接");
    expect(commitFirstCandidate("zh")).toBeNull();
    expect(commitFirstCandidate("")).toBeNull();
  });
});
