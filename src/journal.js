'use strict';

const store = require('./store');

function all() {
  return store.read('journal', []);
}

function published() {
  return all()
    .filter((p) => p.status === 'published')
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
}

function bySlug(slug) {
  return all().find((p) => p.slug === slug) || null;
}

function byId(id) {
  return all().find((p) => p.id === id) || null;
}

function tags() {
  const map = new Map();
  published().forEach((p) => (p.tags || []).forEach((t) => map.set(t, (map.get(t) || 0) + 1)));
  return [...map.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
}

/** Paragraph split — the body is stored as plain text with blank-line breaks. */
function paragraphs(post) {
  return String(post.body || '').split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
}

function readingMinutes(body) {
  const words = String(body || '').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

function fieldsFromBody(body) {
  const title = String(body.title || '').trim();
  return {
    title,
    slug: store.slugify(body.slug || title),
    excerpt: String(body.excerpt || '').trim(),
    body: String(body.body || '').replace(/\r\n/g, '\n').trim(),
    cover: String(body.cover || '').trim() || null,
    author: String(body.author || 'The Atelier').trim(),
    tags: String(body.tags || '').split(/[,|]/).map((t) => t.trim()).filter(Boolean),
    status: body.status === 'published' ? 'published' : 'draft',
    publishedAt: body.publishedAt ? new Date(body.publishedAt).toISOString() : new Date().toISOString(),
    seo: {
      title: String(body.seoTitle || '').trim() || title,
      description: String(body.seoDescription || '').trim() || String(body.excerpt || '').trim()
    }
  };
}

function create(fields) {
  const list = all();
  let slug = fields.slug || store.slugify(fields.title || 'untitled');
  let n = 2;
  while (list.some((p) => p.slug === slug)) slug = (fields.slug || store.slugify(fields.title)) + '-' + n++;

  const post = {
    id: store.nextId('JRN', list),
    ...fields,
    slug,
    readingMinutes: readingMinutes(fields.body)
  };
  store.update('journal', [], (l) => [...l, post], { skipBackup: true });
  return post;
}

function update(id, fields) {
  const list = all();
  if (fields.slug && list.some((p) => p.id !== id && p.slug === fields.slug)) {
    throw new Error(`slug "${fields.slug}" is already used by another post`);
  }
  let updated = null;
  store.update('journal', [], (l) => l.map((p) => {
    if (p.id !== id) return p;
    updated = { ...p, ...fields, readingMinutes: readingMinutes(fields.body || p.body) };
    return updated;
  }), { skipBackup: true });
  return updated;
}

function remove(id) {
  let removed = null;
  store.update('journal', [], (l) => {
    removed = l.find((p) => p.id === id) || null;
    return l.filter((p) => p.id !== id);
  }, { skipBackup: true });
  return removed;
}

function setStatus(id, status) {
  return update(id, { status: status === 'published' ? 'published' : 'draft' });
}

module.exports = { all, published, bySlug, byId, tags, paragraphs, readingMinutes, fieldsFromBody, create, update, remove, setStatus };
