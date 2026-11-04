/// <reference types="electron-vite/node" />

// Ficheros que se incluyen como texto (el puente MCP de Claude Desktop).
declare module '*?raw' {
  const source: string
  export default source
}
