import {sql} from 'drizzle-orm';
import {sqliteTable,text,integer,index,check,primaryKey} from 'drizzle-orm/sqlite-core';
import {libraryReaders,libraryEditions} from './schema';
export const readerRecentViews=sqliteTable('reader_recent_views',{
 readerId:text('reader_id').notNull().references(()=>libraryReaders.id,{onDelete:'restrict'}),editionId:text('edition_id').notNull().references(()=>libraryEditions.id,{onDelete:'restrict'}),viewedAt:text('viewed_at').notNull(),
},t=>[primaryKey({columns:[t.readerId,t.editionId]}),index('idx_reader_recent_owner').on(t.readerId,t.viewedAt)]);
export const readerLiteratureProposals=sqliteTable('reader_literature_proposals',{
 id:text('id').primaryKey(),readerId:text('reader_id').notNull().references(()=>libraryReaders.id,{onDelete:'restrict'}),title:text('title').notNull(),author:text('author').notNull().default(''),note:text('note').notNull().default(''),status:text('status').notNull().default('submitted'),reply:text('reply').notNull().default(''),version:integer('version').notNull().default(1),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),
},t=>[index('idx_literature_proposal_owner').on(t.readerId,t.createdAt),index('idx_literature_proposal_status').on(t.status,t.createdAt),check('literature_proposal_status',sql`${t.status} in ('submitted','in_review','approved','received','rejected')`)]);
export const readerFeedPosts=sqliteTable('reader_feed_posts',{
 id:text('id').primaryKey(),readerId:text('reader_id').notNull().references(()=>libraryReaders.id,{onDelete:'restrict'}),editionId:text('edition_id').references(()=>libraryEditions.id,{onDelete:'restrict'}),body:text('body').notNull(),status:text('status').notNull().default('visible'),version:integer('version').notNull().default(1),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),
},t=>[index('idx_reader_feed_status').on(t.status,t.createdAt),index('idx_reader_feed_owner').on(t.readerId,t.createdAt),check('reader_feed_status',sql`${t.status} in ('visible','hidden','removed')`),check('reader_feed_body',sql`length(${t.body})<=4000`)]);
export const readerFeedComments=sqliteTable('reader_feed_comments',{
 id:text('id').primaryKey(),postId:text('post_id').notNull().references(()=>readerFeedPosts.id,{onDelete:'restrict'}),readerId:text('reader_id').notNull().references(()=>libraryReaders.id,{onDelete:'restrict'}),body:text('body').notNull(),status:text('status').notNull().default('visible'),version:integer('version').notNull().default(1),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),
},t=>[index('idx_reader_feed_comments').on(t.postId,t.status,t.createdAt),index('idx_reader_feed_comment_owner').on(t.readerId,t.createdAt),check('reader_feed_comment_status',sql`${t.status} in ('visible','hidden','removed')`),check('reader_feed_comment_body',sql`length(${t.body})<=2000`)]);
