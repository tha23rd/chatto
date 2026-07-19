const defaultWait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

function inputTypeName(functionName) {
  return `${functionName
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('_')}Inputs`;
}

function parseParaglideSources(source, messageIndex) {
  const functionNames = [...source.matchAll(/^export const ([A-Za-z0-9_]+) =/gm)].map(
    ([, name]) => name
  );
  const aliases = new Map(
    [...messageIndex.matchAll(/^export \{ ([A-Za-z0-9_]+) as "([^"]+)" \}\r?$/gm)].map(
      ([, name, alias]) => [name, alias]
    )
  );
  const typeNames = new Map(
    [...source.matchAll(/^\/\*\* @typedef \{(.*)} ([A-Za-z0-9_]+Inputs) \*\/\r?$/gm)].map(
      ([, body, typeName]) => [typeName, body.trim()]
    )
  );

  const complete =
    functionNames.length > 0 &&
    aliases.size === functionNames.length &&
    functionNames.every(
      (functionName) => aliases.has(functionName) && typeNames.has(inputTypeName(functionName))
    );

  return { aliases, complete, functionNames, typeNames };
}

/**
 * Read Paraglide's generated catalog only after both files contain the same,
 * stable set of messages. Vitest can initialise multiple Vite projects at
 * once, so another Paraglide compiler may be replacing these files while the
 * facade plugin starts.
 */
export async function readStableParaglideSources({
  readSource,
  readIndex,
  wait = defaultWait,
  delayMs = 25,
  maxAttempts = 100
}) {
  let previous;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let source;
    let messageIndex;

    try {
      source = readSource();
      messageIndex = readIndex();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      previous = undefined;
    }

    if (source !== undefined && messageIndex !== undefined) {
      const parsed = parseParaglideSources(source, messageIndex);
      if (
        parsed.complete &&
        previous?.source === source &&
        previous.messageIndex === messageIndex
      ) {
        return { source, messageIndex, ...parsed };
      }

      previous = parsed.complete ? { source, messageIndex } : undefined;
    }

    if (attempt < maxAttempts - 1) await wait(delayMs);
  }

  throw new Error(
    `Paraglide message outputs did not become complete and stable after ${maxAttempts} attempts`
  );
}
