import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { buildShareMarkdown, buildTableMarkdown, buildTablesMarkdown, columnCommentQuery, foreignKeyQuery, indexCatalogQuery, markdownCell, parseColumnComments, parseForeignKeys, parseIndexRows, parseTableList, tableListQuery } = require('../ui/result-markdown.js')

const columns = [{ name: 'status' }, { name: 'total' }]

test('builds a markdown table and leaves SQL out', () => {
  const page = buildShareMarkdown({
    title: '订单状态',
    columns,
    rows: [['paid', 3], { status: 'refunded', total: null }],
    database: 'shop',
    sql: 'select secret from users',
    includeSql: false,
  })
  assert.match(page.markdown, /^\| status \| total \|/m)
  assert.match(page.markdown, /\| paid \| 3 \|/)
  assert.match(page.markdown, /\| refunded \|  \|/)
  assert.equal(page.markdown.includes('secret'), false)
  assert.equal(page.rowCount, 2)
})

test('escapes pipes, flattens newlines, and clips long cells', () => {
  assert.equal(markdownCell('a|b\nc'), 'a\\|b c')
  const huge = '字'.repeat(2001)
  assert.equal(markdownCell(huge).endsWith('…'), true)
  assert.equal(markdownCell(huge).length, 2001)
})

test('includes SQL in a fence that cannot be closed early', () => {
  const page = buildShareMarkdown({
    title: 'with sql',
    columns: ['id'],
    rows: [[1]],
    includeSql: true,
    sql: 'select ```hidden``` from t',
  })
  assert.match(page.markdown, /````sql\nselect ```hidden``` from t\n````/)
})

test('rejects an empty result shape and an oversized page', () => {
  assert.throws(() => buildShareMarkdown({ columns: [], rows: [] }), (error) => error.code === 'NO_COLUMNS')
  assert.throws(
    () => buildShareMarkdown({
      columns: ['blob'],
      rows: [['字'.repeat(2000)], ['字'.repeat(2000)]],
      note: 'x'.repeat(2_000_000),
    }),
    (error) => error.code === 'TOO_LARGE',
  )
})

test('builds a table definition without keys or connection data', () => {
  const page = buildTableMarkdown({
    table: 'users',
    schema: 'public',
    database: 'shop',
    connectionId: 'secret-connection',
    note: '不含主键、索引、外键和注释',
    ddlHeading: '字段定义',
    headers: { name: '字段', type: '类型', nullable: '可空', defaultValue: '默认值' },
    yes: '是',
    no: '否',
    columns: [
      { name: 'id', dataType: 'integer', nullable: false, precision: 32, default: "nextval('users_id_seq')" },
      { name: 'order detail', dataType: 'varchar', nullable: true, length: 40 },
      { name: 'amount', dataType: 'numeric', precision: 10, scale: 2 },
    ],
  })
  assert.match(page.ddl, /CREATE TABLE public\.users \(/)
  assert.match(page.ddl, /id integer\(32\) NOT NULL DEFAULT nextval\('users_id_seq'\)/)
  assert.match(page.ddl, /"order detail" varchar\(40\)/)
  assert.match(page.ddl, /amount numeric\(10, 2\)/)
  assert.match(page.markdown, /\| id \| integer\(32\) \| 否 \|/)
  assert.match(page.markdown, /\| order detail \| varchar\(40\) \| 是 \|/)
  assert.equal(page.markdown.includes('PRIMARY KEY'), false)
  assert.equal(page.markdown.includes('secret-connection'), false)
  assert.equal(page.markdown.includes('INDEX'), false)
})

test('adds primary and secondary indexes without the connection id', () => {
  const page = buildTableMarkdown({
    table: 'collection',
    database: 'html_url',
    connectionId: 'secret-connection',
    ddlHeading: '表结构',
    indexHeading: '索引',
    noIndexes: '这张表没有索引。',
    indexHeaders: { name: '索引', kind: '类型', columns: '字段' },
    indexKinds: { primary: '主键', unique: '唯一', fulltext: '全文', spatial: '空间', plain: '普通' },
    headers: { name: '字段', type: '类型', nullable: '可空', defaultValue: '默认值' },
    yes: '是',
    no: '否',
    columns: [{ name: 'id', dataType: 'int', nullable: false, length: 10 }],
    indexes: [
      { name: 'PRIMARY', primary: true, unique: true, type: 'BTREE', columns: ['id'] },
      { name: 'idx_name', primary: false, unique: false, type: 'BTREE', columns: ['name', 'user_id'] },
      { name: 'ft_desc', primary: false, unique: false, type: 'FULLTEXT', columns: ['description'] },
    ],
  })
  assert.match(page.markdown, /\| PRIMARY \| 主键 \| id \|/)
  assert.match(page.markdown, /\| idx_name \| 普通 \| name, user_id \|/)
  assert.match(page.markdown, /\| ft_desc \| 全文 \| description \|/)
  assert.match(page.ddl, /ALTER TABLE html_url\.collection ADD PRIMARY KEY \(id\);/)
  assert.match(page.ddl, /CREATE INDEX idx_name ON html_url\.collection \(name, user_id\);/)
  assert.match(page.ddl, /CREATE FULLTEXT INDEX ft_desc ON html_url\.collection \(description\);/)
  assert.equal(page.markdown.includes('secret-connection'), false)
})

test('says when a table has no indexes', () => {
  const page = buildTableMarkdown({
    table: 'collection',
    columns: [{ name: 'id', dataType: 'int' }],
    indexes: [],
    noIndexes: '这张表没有索引。',
  })
  assert.match(page.markdown, /这张表没有索引。/)
  assert.equal(page.ddl.includes('PRIMARY KEY'), false)
  assert.equal(page.ddl.includes('CREATE INDEX'), false)
})

test('builds a catalog query for MySQL and leaves other engines alone', () => {
  const mysql = indexCatalogQuery({
    dbType: 'MySQL',
    database: "html'url",
    table: 'collection',
    connectionId: 'secret-connection',
  })
  assert.match(mysql, /FROM information_schema\.STATISTICS/)
  assert.match(mysql, /TABLE_SCHEMA = 'html''url'/)
  assert.match(mysql, /TABLE_NAME = 'collection'/)
  assert.equal(mysql.includes('secret-connection'), false)
  assert.equal(mysql.includes('SHOW CREATE TABLE'), false)
  const postgres = indexCatalogQuery({ dbType: 'PostgreSQL', schema: 'public', table: 'users' })
  assert.match(postgres, /FROM pg_class t/)
  assert.match(postgres, /n\.nspname = 'public'/)
  assert.equal(indexCatalogQuery({ dbType: 'redis', database: 'db', table: 'users' }), null)
  assert.equal(indexCatalogQuery({ dbType: 'mysql', table: 'users' }), null)
})

test('groups index columns by sequence', () => {
  const indexes = parseIndexRows({
    columns: [
      { name: 'index_name' },
      { name: 'is_unique' },
      { name: 'is_primary' },
      { name: 'seq_in_index' },
      { name: 'column_name' },
      { name: 'index_type' },
    ],
    rows: [
      ['PRIMARY', 1, 1, 1, 'id', 'BTREE'],
      ['idx_pair', 0, 0, 2, 'user_id', 'BTREE'],
      ['idx_pair', 0, 0, 1, 'name', 'BTREE'],
      ['idx_pair', 0, 0, 1, 'name', 'BTREE'],
    ],
  })
  assert.equal(indexes.length, 2)
  assert.equal(indexes[0].primary, true)
  assert.deepEqual(indexes[0].columns, ['id'])
  assert.equal(indexes[1].unique, false)
  assert.deepEqual(indexes[1].columns, ['name', 'user_id'])
})

test('builds one page for several tables', () => {
  const page = buildTablesMarkdown({
    title: 'html_url',
    summary: 'html_url · 2 张表',
    note: '说明',
    database: 'html_url',
    headers: { name: '字段', type: '类型', nullable: '可空', defaultValue: '默认值' },
    yes: '是',
    no: '否',
    indexHeading: '索引',
    ddlHeading: '表结构',
    noIndexes: '这张表没有索引。',
    tables: [
      {
        table: 'collection',
        comment: '用户页面集合',
        columns: [{ name: 'id', dataType: 'int', nullable: false }],
        indexes: [],
      },
      {
        table: 'deployment',
        comment: '发布页面',
        columns: [{ name: 'id', dataType: 'int', nullable: false }],
        indexes: [{ name: 'PRIMARY', primary: true, unique: true, type: 'BTREE', columns: ['id'] }],
      },
    ],
  })
  assert.match(page.markdown, /^# html_url/m)
  assert.match(page.markdown, /## collection/)
  assert.match(page.markdown, /用户页面集合/)
  assert.match(page.markdown, /## deployment/)
  assert.match(page.markdown, /ALTER TABLE html_url\.deployment ADD PRIMARY KEY \(id\);/)
  assert.equal(page.tableCount, 2)
  assert.equal((page.markdown.match(/^# /gm) || []).length, 1)
})

test('adds column comments, table comments, and foreign keys', () => {
  const page = buildTableMarkdown({
    table: 'collection',
    database: 'html_url',
    dbType: 'MySQL',
    connectionId: 'secret-connection',
    comment: "用户'页面",
    ddlHeading: '表结构',
    indexHeading: '索引',
    foreignKeyHeading: '外键',
    noIndexes: '这张表没有索引。',
    noForeignKeys: '这张表没有外键。',
    headers: { name: '字段', type: '类型', nullable: '可空', defaultValue: '默认值', comment: '注释' },
    foreignKeyHeaders: { name: '外键', columns: '字段', references: '引用', deleteRule: '删除时', updateRule: '更新时' },
    yes: '是',
    no: '否',
    columns: [
      { name: 'id', dataType: 'int', nullable: false, length: 11 },
      { name: 'user_id', dataType: 'int', nullable: true, length: 11 },
      { name: 'note', dataType: 'varchar', length: 40 },
    ],
    columnComments: [
      { name: 'id', comment: '主键' },
      { name: 'note', comment: "a|b\\it's" },
    ],
    indexes: [{ name: 'PRIMARY', primary: true, unique: true, type: 'BTREE', columns: ['id'] }],
    foreignKeys: [
      {
        name: 'fk_collection_user',
        columns: ['user_id', 'org_id'],
        referencedSchema: 'html_url',
        referencedTable: 'user',
        referencedColumns: ['id', 'org_id'],
        deleteRule: 'CASCADE',
        updateRule: 'NO ACTION',
      },
      {
        name: 'fk_plain',
        columns: ['id'],
        referencedSchema: 'html_url',
        referencedTable: 'other',
        referencedColumns: ['id'],
        deleteRule: 'RESTRICT',
        updateRule: 'SET NULL',
      },
    ],
  })
  assert.match(page.markdown, /\| id \| int\(11\) \| 否 \|  \| 主键 \|/)
  assert.match(page.markdown, /\| note \| varchar\(40\) \|  \|  \| a\\\|b\\it's \|/)
  assert.match(page.markdown, /用户'页面/)
  assert.match(page.markdown, /\| fk_collection_user \| user_id, org_id \| html_url\.user \(id, org_id\) \| CASCADE \| NO ACTION \|/)
  assert.match(page.ddl, /id int\(11\) NOT NULL COMMENT '主键'/)
  assert.match(page.ddl, /note varchar\(40\) COMMENT 'a\|b\\\\it''s'/)
  assert.match(page.ddl, /ALTER TABLE html_url\.collection ADD CONSTRAINT fk_collection_user FOREIGN KEY \(user_id, org_id\) REFERENCES html_url\.user \(id, org_id\) ON DELETE CASCADE;/)
  assert.match(page.ddl, /ALTER TABLE html_url\.collection ADD CONSTRAINT fk_plain FOREIGN KEY \(id\) REFERENCES html_url\.other \(id\) ON UPDATE SET NULL;/)
  assert.equal(page.ddl.includes('ON UPDATE NO ACTION'), false)
  assert.equal(page.ddl.includes('ON DELETE RESTRICT'), false)
  assert.match(page.ddl, /ALTER TABLE html_url\.collection COMMENT = '用户''页面';/)
  assert.equal(page.markdown.includes('secret-connection'), false)
  assert.equal(page.markdown.includes('SHOW CREATE TABLE'), false)
  assert.equal(page.columnCount, 5)
})

test('uses the catalog comment style of each engine', () => {
  const postgres = buildTableMarkdown({
    table: 'users',
    schema: 'public',
    dbType: 'PostgreSQL',
    comment: 'people',
    columns: [{ name: 'id', dataType: 'int', comment: 'key' }],
  })
  assert.match(postgres.ddl, /COMMENT ON TABLE public\.users IS 'people';/)
  assert.equal(postgres.ddl.includes('ALTER TABLE public.users COMMENT'), false)
  const sqlserver = buildTableMarkdown({
    table: 'users',
    schema: 'dbo',
    dbType: 'SQL Server',
    comment: 'people',
    columns: [{ name: 'id', dataType: 'int' }],
  })
  assert.match(sqlserver.markdown, /people/)
  assert.equal(sqlserver.ddl.includes('COMMENT'), false)
})

test('reads comments and foreign keys from the catalog', () => {
  const comments = columnCommentQuery({ dbType: 'MySQL', database: "html'url", table: 'collection', connectionId: 'secret-connection' })
  assert.match(comments, /FROM information_schema\.COLUMNS/)
  assert.match(comments, /COLUMN_COMMENT/)
  assert.match(comments, /TABLE_SCHEMA = 'html''url'/)
  assert.equal(comments.includes('secret-connection'), false)
  assert.equal(comments.includes('SHOW CREATE TABLE'), false)
  const keys = foreignKeyQuery({ dbType: 'MySQL', database: 'html_url', table: 'collection' })
  assert.match(keys, /information_schema\.KEY_COLUMN_USAGE/)
  assert.match(keys, /information_schema\.REFERENTIAL_CONSTRAINTS/)
  assert.match(keys, /REFERENCED_TABLE_NAME IS NOT NULL/)
  assert.match(foreignKeyQuery({ dbType: 'PostgreSQL', schema: 'public', table: 'users' }), /con\.contype = 'f'/)
  assert.match(foreignKeyQuery({ dbType: 'SQL Server', schema: 'dbo', table: 'users' }), /sys\.foreign_keys/)
  assert.match(columnCommentQuery({ dbType: 'PostgreSQL', schema: 'public', table: 'users' }), /col_description/)
  assert.equal(columnCommentQuery({ dbType: 'redis', database: 'db', table: 'users' }), null)
  assert.equal(foreignKeyQuery({ dbType: 'mysql', table: 'users' }), null)
  assert.deepEqual(parseColumnComments({
    columns: ['column_name', 'column_comment'],
    rows: [['id', '主键'], ['id', '重复'], ['note', ''], ['user_id', '所属用户']],
  }), [
    { name: 'id', comment: '主键' },
    { name: 'user_id', comment: '所属用户' },
  ])
  const parsed = parseForeignKeys({
    columns: ['constraint_name', 'column_name', 'ordinal_position', 'referenced_schema', 'referenced_table', 'referenced_column', 'update_rule', 'delete_rule'],
    rows: [
      ['fk_pair', 'org_id', 2, 'html_url', 'user', 'org_id', 'NO_ACTION', 'SET_NULL'],
      ['fk_pair', 'user_id', 1, 'html_url', 'user', 'id', 'NO_ACTION', 'SET_NULL'],
      ['fk_pair', 'user_id', 1, 'html_url', 'user', 'id', 'NO_ACTION', 'SET_NULL'],
      ['fk_skip', '', 1, 'html_url', 'user', 'id', 'CASCADE', 'CASCADE'],
    ],
  })
  assert.equal(parsed.length, 1)
  assert.deepEqual(parsed[0].columns, ['user_id', 'org_id'])
  assert.deepEqual(parsed[0].referencedColumns, ['id', 'org_id'])
  assert.equal(parsed[0].deleteRule, 'SET NULL')
  assert.equal(parsed[0].updateRule, 'NO ACTION')
})

test('lists base tables for MySQL and ignores other engines', () => {
  const sql = tableListQuery({ dbType: 'MySQL', database: "html'url" })
  assert.match(sql, /FROM information_schema\.TABLES/)
  assert.match(sql, /TABLE_SCHEMA = 'html''url'/)
  assert.match(sql, /TABLE_TYPE = 'BASE TABLE'/)
  assert.equal(sql.includes('SHOW CREATE TABLE'), false)
  assert.equal(tableListQuery({ dbType: 'redis', database: 'db' }), null)
  const tables = parseTableList({
    columns: ['table_name', 'table_comment'],
    rows: [['collection', '用户页面集合'], ['collection', '重复'], ['deployment', '']],
  })
  assert.deepEqual(tables, [
    { name: 'collection', comment: '用户页面集合' },
    { name: 'deployment', comment: '' },
  ])
})

test('rejects a table page without a name', () => {
  assert.throws(() => buildTableMarkdown({ columns: [{ name: 'id' }] }), (error) => error.code === 'NO_TABLE')
})

test('the plugin page inlines the table builder', () => {
  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8')
  const lib = fs.readFileSync(new URL('../ui/result-markdown.js', import.meta.url), 'utf8').trim()
  assert.equal(html.includes(lib), true)
  assert.equal(html.includes('src="./result-markdown.js"'), false)
})

test('the page reads table metadata and does not ask the database for DDL', () => {
  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8')
  assert.equal(html.includes('getTableMetadata'), true)
  assert.equal(html.includes('schemaMetadataApi'), true)
  assert.equal(html.includes('buildTableMarkdown'), true)
  assert.equal(html.includes('SHOW CREATE TABLE'), false)
  assert.equal(html.includes('indexCatalogQuery'), true)
  assert.equal(html.includes('columnCommentQuery'), true)
  assert.equal(html.includes('foreignKeyQuery'), true)
  assert.equal(html.includes('information_schema.REFERENTIAL_CONSTRAINTS'), true)
  assert.equal(html.includes('id="tableList"'), true)
  assert.equal(html.includes('id="template"'), true)
  assert.equal(html.includes('id="theme"'), true)
  assert.equal(html.includes('information_schema.STATISTICS'), true)
  const built = html.slice(html.lastIndexOf('buildTablesMarkdown({'), html.lastIndexOf('tables,'))
  assert.equal(built.includes('connectionId'), false)
  assert.equal(html.includes('/api/dbx/token-grant'), true)
  assert.equal(html.includes('id="fetchToken"'), true)
})

test('makes duplicate column names unique', () => {
  const page = buildShareMarkdown({
    columns: ['id', 'id', { name: '' }],
    rows: [[1, 2, 3]],
    columnFallback: (index) => 'column_' + (index + 1),
  })
  assert.match(page.markdown, /\| id \| id_2 \| column_3 \|/)
})
