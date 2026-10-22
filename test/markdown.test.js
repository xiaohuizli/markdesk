import test from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { renderMarkdown } from '../public/markdown.js';
const parser = () => new MarkdownIt({ html:false, linkify:true });
test('Markdown preview maps formatted headings, paragraphs and code blocks back to source lines',()=>{
 const html=renderMarkdown(parser(),'# 标题\n\n中文🙂 **REA_CHAIN**\n\n```js\nconst a=1;\n```\n');
 assert.match(html,/<h1[^>]*data-source-start="1"[^>]*data-source-end="1"[^>]*>标题<\/h1>/);
 assert.match(html,/<p[^>]*data-source-start="3"[^>]*data-source-end="3"[^>]*>中文🙂 <strong>REA_CHAIN<\/strong>/);
 assert.match(html,/const a=1;/);
});
test('Markdown preview escapes executable markup and rejects javascript links',()=>{
 const html=renderMarkdown(parser(),'<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n\n<script>alert(1)</script>');
 assert.ok(!html.includes('<img'));assert.ok(!html.includes('<script'));assert.ok(!html.includes('href="javascript:'));assert.ok(html.includes('&lt;script&gt;'));
});
