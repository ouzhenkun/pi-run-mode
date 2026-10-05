import { lstatSync, realpathSync } from "node:fs";
import { posix as path } from "node:path";

type Word = { value: string; literal: boolean };

function commandWords(command: string): Word[][] {
  const commands: Word[][] = [];
  let words: Word[] = [];
  let word: Word | null = null;
  let quote = "";
  const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
  const finishWord = () => {
    if (word) words.push(word);
    word = null;
  };
  const finishCommand = () => {
    finishWord();
    if (words.length) commands.push(words);
    words = [];
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "\\" && quote !== "'") {
      const next = command[i + 1];
      if (next === "\n") { i++; continue; }
      word ??= { value: "", literal: true };
      if (next === undefined) { word.literal = false; continue; }
      if (!quote || /[\$`"\\]/.test(next)) {
        word.value += next;
        i++;
      } else {
        word.value += char;
      }
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else {
        word!.value += char;
        if (quote === '"' && /[\$`]/.test(char)) word!.literal = false;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      word ??= { value: "", literal: true };
      quote = char;
    } else if (char === "#" && !word) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
    } else if (char === "\n" && heredocs.length) {
      finishCommand();
      for (const { delimiter, stripTabs } of heredocs.splice(0)) {
        while (i + 1 < command.length) {
          const start = i + 1;
          const end = command.indexOf("\n", start);
          const line = command.slice(start, end < 0 ? command.length : end);
          i = end < 0 ? command.length - 1 : end;
          if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
        }
      }
    } else if (/[<>]/.test(char) || (char === "&" && command[i + 1] === ">")) {
      const heredoc = command.slice(i).match(/^<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\\\n]+)"|([a-zA-Z_][a-zA-Z0-9_]*))(?=[ \t\n;|&<>]|$)/);
      if (heredoc) {
        heredocs.push({ delimiter: heredoc[2] ?? heredoc[3] ?? heredoc[4], stripTabs: heredoc[1] === "-" });
        i += heredoc[0].length - 1;
      }
      finishWord();
      // Redirections can appear between rm operands, not only at the end.
      words.push({ value: char, literal: false });
      finishCommand();
    } else if (/[;|&\n()]/.test(char)) {
      if (char === "(" && word) word.literal = false;
      finishCommand();
    } else if (/\s/.test(char)) {
      finishWord();
    } else {
      word ??= { value: "", literal: true };
      word.value += char;
      if (/[\$`*?\[\]{}~]/.test(char)) word.literal = false;
    }
  }
  if (quote && word) word.literal = false;
  finishCommand();
  return commands;
}

function resolvedPath(target: string): string | null {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || current === "/") return null;
      missing.unshift(path.basename(current));
      current = path.dirname(current);
      continue;
    }
    try {
      return path.join(realpathSync(current), ...missing);
    } catch {
      // A dangling symlink must not be treated as a nonexistent ordinary path.
      return null;
    }
  }
}

function isTemporaryTarget(word: Word): boolean {
  if (!word.literal || !word.value.startsWith("/") || word.value.split("/").includes("..")) return false;
  const target = path.normalize(word.value).replace(/\/+$/, "");
  const root = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"]
    .find((dir) => target.startsWith(dir + "/"))
    ?? target.match(/^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T(?=\/)/)?.[0];
  if (!root) return false;
  const actualRoot = resolvedPath(root);
  const actualTarget = resolvedPath(target);
  const alias = root.startsWith("/private/") ? root.slice("/private".length) : "/private" + root;
  return actualRoot !== null && [root, alias].includes(actualRoot)
    && actualTarget !== null && actualTarget.startsWith(actualRoot + "/");
}

export function classifyRm(command: string): "dangerous" | "mutating" | null {
  let found = false;
  let precedingInspection = true;
  for (const words of commandWords(command)) {
    if (!words[0].literal || !["rm", "/bin/rm", "/usr/bin/rm"].includes(words[0].value)) {
      // Earlier mutations may create a symlink after the filesystem check.
      precedingInspection &&= words.every((word) => word.literal)
        && /^(?:pwd|ls|ll|cat|bat|head|tail|less|wc|rg|grep|ag|ack|which|whereis|file|stat|du|df|echo|printf)$/.test(words[0].value);
      continue;
    }
    found = true;
    let recursive = false;
    let force = false;
    let options = true;
    let uncertain = false;
    const targets: Word[] = [];
    for (const word of words.slice(1)) {
      if (options && !word.literal) uncertain = true;
      if (options && word.value === "--") {
        if (targets.length) uncertain = true;
        options = false;
      } else if (options && word.value.startsWith("--")) {
        // BSD rm stops parsing options at the first operand; GNU rm need not.
        if (targets.length) uncertain = true;
        if (word.value === "--recursive") recursive = true;
        else if (word.value === "--force") force = true;
        else if (!/^(?:--dir|--verbose|--interactive(?:=(?:never|once|always))?|--(?:no-)?preserve-root|--preserve-root=all|--one-file-system)$/.test(word.value)) uncertain = true;
      } else if (options && /^-[a-zA-Z]+$/.test(word.value)) {
        if (targets.length) uncertain = true;
        recursive ||= /[rR]/.test(word.value);
        force ||= word.value.includes("f");
        if (/[^rRfivdIPW-]/.test(word.value)) uncertain = true;
      } else {
        if (options && word.value.startsWith("-")) uncertain = true;
        targets.push(word);
      }
    }
    if (uncertain || (recursive && force && (!precedingInspection || !targets.length || !targets.every(isTemporaryTarget)))) return "dangerous";
  }
  return found ? "mutating" : null;
}
