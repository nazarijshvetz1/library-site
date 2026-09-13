import {sql} from 'drizzle-orm';
import {sqliteTable,text,integer,index,check,primaryKey,uniqueIndex} from 'drizzle-orm/sqlite-core';
import {libraryReaders,libraryEditions} from './schema';
export const readerRecentViews=sqliteTable('reader_recent_views',{
 readerId:text('reader_id').notNull().references(()=>libraryReaders.id,{onDelete:'restrict'}),editionId:text('edition_id').notNull().references(()=>libraryEditions.id,{onDelete:'restrict'}),viewedAt:text('viewed_at').notNull(),
},t=>[primaryKey({columns:[t.readerId,t.editionId]}),index('idx_reader_recent_owner').on(t.readerId,t.viewedAt)]);
export const readerLiteratureProposals=sqliteTable('reader_literature_proposals',{
 id:text('id').primaryKey(),readerId:text('reader_id').notNull().references(()=>libraryReaders.id,{onDelete:'restrict'}),title:text('title').notNull(),author:text('author').notNull().default(''),note:text('note').notNull().default(''),status:text('status').notNull().default('submitted'),reply:text('reply').notNull().default(''),version:integer('version').notNull().default(1),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),
 workflowStatus:text('workflow_status'),editionId:text('edition_id').references(()=>libraryEditions.id,{onDelete:'restrict'}),
},t=>[check('reader_proposal_workflow',sql`${t.workflowStatus} is null or ${t.workflowStatus} in ('submitted','approved','ordered','available')`),index('idx_literature_proposal_owner').on(t.readerId,t.createdAt),index('idx_literature_proposal_status').on(t.status,t.createdAt),check('literature_proposal_status',sql`${t.status} in ('submitted','in_review','approved','received','rejected')`)]);
export const readerFeedPosts=sqliteTable('reader_feed_posts',{
 id:text('id').primaryKey(),readerId:text('reader_id').notNull().references(()=>libraryReaders.id,{onDelete:'restrict'}),editionId:text('edition_id').references(()=>libraryEditions.id,{onDelete:'restrict'}),body:text('body').notNull(),status:text('status').notNull().default('visible'),version:integer('version').notNull().default(1),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),
},t=>[index('idx_reader_feed_status').on(t.status,t.createdAt),index('idx_reader_feed_owner').on(t.readerId,t.createdAt),check('reader_feed_status',sql`${t.status} in ('visible','hidden','removed')`),check('reader_feed_body',sql`length(${t.body})<=4000`)]);
export const readerFeedComments=sqliteTable('reader_feed_comments',{
 id:text('id').primaryKey(),postId:text('post_id').notNull().references(()=>readerFeedPosts.id,{onDelete:'restrict'}),readerId:text('reader_id').notNull().references(()=>libraryReaders.id,{onDelete:'restrict'}),body:text('body').notNull(),status:text('status').notNull().default('visible'),version:integer('version').notNull().default(1),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),
},t=>[index('idx_reader_feed_comments').on(t.postId,t.status,t.createdAt),index('idx_reader_feed_comment_owner').on(t.readerId,t.createdAt),check('reader_feed_comment_status',sql`${t.status} in ('visible','hidden','removed')`),check('reader_feed_comment_body',sql`length(${t.body})<=2000`)]);

export const readerMessages=sqliteTable('reader_messages',{
 id:text('id').primaryKey(),readerId:text('reader_id').notNull().references(()=>libraryReaders.id,{onDelete:'restrict'}),
 dedupeKey:text('dedupe_key').notNull(),kind:text('kind').notNull(),day:text('day').notNull(),
 title:text('title').notNull(),body:text('body').notNull(),payloadJson:text('payload_json').notNull().default('{}'),
 targetTab:text('target_tab').notNull(),readAt:text('read_at'),createdAt:text('created_at').notNull(),
 deliveryStatus:text('delivery_status').notNull().default('pending'),attempts:integer('attempts').notNull().default(0),
 nextAttemptAt:text('next_attempt_at').notNull(),leaseToken:text('lease_token'),leaseUntil:text('lease_until'),sentAt:text('sent_at'),lastError:text('last_error'),
},t=>[uniqueIndex('idx_reader_message_dedupe').on(t.dedupeKey),index('idx_reader_message_owner').on(t.readerId,t.createdAt),index('idx_reader_message_delivery').on(t.deliveryStatus,t.nextAttemptAt),
 check('reader_message_kind',sql`${t.kind} in ('loan_digest','proposal')`),
 check('reader_message_delivery_status',sql`${t.deliveryStatus} in ('pending','processing','retry','sent','unavailable','disabled','cancelled','uncertain')`)]);
