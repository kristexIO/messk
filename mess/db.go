package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type DB struct {
	db *sql.DB
}

const offlineDeliveryBatchLimit = 1000

type GroupRecord struct {
	ID          string    `json:"id"`
	Title       string    `json:"title"`
	Avatar      string    `json:"avatar,omitempty"`
	OwnerPubKey string    `json:"ownerPubKey"`
	Role        string    `json:"role"`
	CreatedAt   time.Time `json:"createdAt"`
}

type GroupMemberRecord struct {
	GroupID      string    `json:"groupId"`
	MemberPubKey string    `json:"memberPubKey"`
	Role         string    `json:"role"`
	JoinedAt     time.Time `json:"joinedAt"`
}

type ChannelRecord struct {
	ID          string    `json:"id"`
	Title       string    `json:"title"`
	Avatar      string    `json:"avatar,omitempty"`
	OwnerPubKey string    `json:"ownerPubKey"`
	Role        string    `json:"role"`
	CreatedAt   time.Time `json:"createdAt"`
}

type ChannelSubscriberRecord struct {
	ChannelID        string    `json:"channelId"`
	SubscriberPubKey string    `json:"subscriberPubKey"`
	Role             string    `json:"role"`
	JoinedAt         time.Time `json:"joinedAt"`
}

type ModerationAuditRecord struct {
	ID          int64     `json:"id"`
	EntityType  string    `json:"entityType"`
	EntityID    string    `json:"entityId"`
	ActorPubKey string    `json:"actorPubKey"`
	Action      string    `json:"action"`
	Target      string    `json:"target"`
	Details     string    `json:"details"`
	CreatedAt   time.Time `json:"createdAt"`
}

type InviteLinkRecord struct {
	Token           string     `json:"token"`
	EntityType      string     `json:"entityType"`
	EntityID        string     `json:"entityId"`
	CreatedByPubKey string     `json:"createdByPubKey"`
	CreatedAt       time.Time  `json:"createdAt"`
	ExpiresAt       *time.Time `json:"expiresAt,omitempty"`
	MaxUses         *int       `json:"maxUses,omitempty"`
	UsesCount       int        `json:"usesCount"`
	HasPassword     bool       `json:"hasPassword"`
	Revoked         bool       `json:"revoked"`
}

type SessionTokenRecord struct {
	Token     string    `json:"token"`
	PubKey    string    `json:"pubKey"`
	CreatedAt time.Time `json:"createdAt"`
	LastSeen  time.Time `json:"lastSeen"`
	ExpiresAt time.Time `json:"expiresAt"`
	UserAgent string    `json:"userAgent"`
	RemoteIP  string    `json:"remoteIp"`
}

type FileTokenRecord struct {
	Token     string
	Filename  string
	ExpiresAt time.Time
}

var (
	ErrInviteNotFound         = sql.ErrNoRows
	ErrInviteRevoked          = errors.New("invite revoked")
	ErrInviteExpired          = errors.New("invite expired")
	ErrInviteUsageLimit       = errors.New("invite usage limit reached")
	ErrInvitePasswordRequired = errors.New("invite password required")
	ErrInvitePasswordInvalid  = errors.New("invite password invalid")
)

func InitDB(ctx context.Context, dataSourceName string) *DB {
	db, err := sql.Open("sqlite", dataSourceName)
	if err != nil {
		log.Fatalf("Unable to open database: %v", err)
	}

	// Проверяем подключение
	if err := db.Ping(); err != nil {
		log.Fatalf("Unable to connect to database: %v", err)
	}

	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(30 * time.Minute)

	if _, err := db.ExecContext(ctx, `
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = NORMAL;
		PRAGMA busy_timeout = 5000;
		PRAGMA foreign_keys = ON;
		PRAGMA temp_store = MEMORY;
	`); err != nil {
		log.Fatalf("Failed to tune database connection: %v", err)
	}

	// Миграция: создание таблицы пользователей
	_, err = db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS users (
			pub_key TEXT PRIMARY KEY,
			nickname TEXT,
			avatar TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE TABLE IF NOT EXISTS offline_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			sender_pub_key TEXT,
			recipient_pub_key TEXT,
			msg_id TEXT,
			payload BLOB NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (sender_pub_key) REFERENCES users(pub_key) ON DELETE CASCADE,
			FOREIGN KEY (recipient_pub_key) REFERENCES users(pub_key) ON DELETE CASCADE
		);

		CREATE TABLE IF NOT EXISTS prekeys (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_pub_key TEXT,
			prekey_pub_key TEXT NOT NULL,
			FOREIGN KEY (user_pub_key) REFERENCES users(pub_key) ON DELETE CASCADE
		);

		CREATE TABLE IF NOT EXISTS groups_meta (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			avatar TEXT,
			owner_pub_key TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (owner_pub_key) REFERENCES users(pub_key) ON DELETE CASCADE
		);

		CREATE TABLE IF NOT EXISTS group_members (
			group_id TEXT NOT NULL,
			member_pub_key TEXT NOT NULL,
			role TEXT NOT NULL DEFAULT 'member',
			joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY (group_id, member_pub_key),
			FOREIGN KEY (group_id) REFERENCES groups_meta(id) ON DELETE CASCADE,
			FOREIGN KEY (member_pub_key) REFERENCES users(pub_key) ON DELETE CASCADE
		);

		CREATE TABLE IF NOT EXISTS channels (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			avatar TEXT,
			owner_pub_key TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (owner_pub_key) REFERENCES users(pub_key) ON DELETE CASCADE
		);

		CREATE TABLE IF NOT EXISTS channel_subscribers (
			channel_id TEXT NOT NULL,
			subscriber_pub_key TEXT NOT NULL,
			role TEXT NOT NULL DEFAULT 'subscriber',
			joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY (channel_id, subscriber_pub_key),
			FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
			FOREIGN KEY (subscriber_pub_key) REFERENCES users(pub_key) ON DELETE CASCADE
		);

		CREATE TABLE IF NOT EXISTS group_invite_links (
			token TEXT PRIMARY KEY,
			group_id TEXT NOT NULL,
			created_by_pub_key TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (group_id) REFERENCES groups_meta(id) ON DELETE CASCADE,
			FOREIGN KEY (created_by_pub_key) REFERENCES users(pub_key) ON DELETE CASCADE
		);

		CREATE TABLE IF NOT EXISTS channel_invite_links (
			token TEXT PRIMARY KEY,
			channel_id TEXT NOT NULL,
			created_by_pub_key TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
			FOREIGN KEY (created_by_pub_key) REFERENCES users(pub_key) ON DELETE CASCADE
		);

		CREATE TABLE IF NOT EXISTS moderation_audit (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			entity_type TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			actor_pub_key TEXT NOT NULL,
			action TEXT NOT NULL,
			target TEXT NOT NULL DEFAULT '',
			details TEXT NOT NULL DEFAULT '',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE TABLE IF NOT EXISTS session_tokens (
			token TEXT PRIMARY KEY,
			pub_key TEXT NOT NULL,
			created_at DATETIME NOT NULL,
			last_seen DATETIME NOT NULL,
			expires_at DATETIME NOT NULL,
			user_agent TEXT NOT NULL DEFAULT '',
			remote_ip TEXT NOT NULL DEFAULT '',
			FOREIGN KEY (pub_key) REFERENCES users(pub_key) ON DELETE CASCADE
		);

		CREATE TABLE IF NOT EXISTS file_tokens (
			token TEXT PRIMARY KEY,
			filename TEXT NOT NULL,
			expires_at DATETIME NOT NULL
		);

		CREATE TABLE IF NOT EXISTS file_access (
			filename TEXT NOT NULL,
			pub_key TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY (filename, pub_key),
			FOREIGN KEY (pub_key) REFERENCES users(pub_key) ON DELETE CASCADE
		);

		-- Performance Indexes
		CREATE INDEX IF NOT EXISTS idx_offline_recipient ON offline_messages(recipient_pub_key);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_offline_recipient_msg_id ON offline_messages(recipient_pub_key, msg_id) WHERE msg_id IS NOT NULL;
		CREATE INDEX IF NOT EXISTS idx_prekeys_user ON prekeys(user_pub_key);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_prekeys_user_prekey ON prekeys(user_pub_key, prekey_pub_key);
		CREATE INDEX IF NOT EXISTS idx_group_members_member ON group_members(member_pub_key);
		CREATE INDEX IF NOT EXISTS idx_channel_subscribers_member ON channel_subscribers(subscriber_pub_key);
		CREATE INDEX IF NOT EXISTS idx_group_invite_links_group ON group_invite_links(group_id);
		CREATE INDEX IF NOT EXISTS idx_channel_invite_links_channel ON channel_invite_links(channel_id);
		CREATE INDEX IF NOT EXISTS idx_moderation_audit_entity ON moderation_audit(entity_type, entity_id, created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_session_tokens_pub_key ON session_tokens(pub_key, created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_session_tokens_expires_at ON session_tokens(expires_at);
		CREATE INDEX IF NOT EXISTS idx_file_tokens_expires_at ON file_tokens(expires_at);
		CREATE INDEX IF NOT EXISTS idx_file_access_filename ON file_access(filename);
	`)
	if err != nil {
		log.Fatalf("Failed to initialize database schema: %v", err)
	}

	if _, err := db.ExecContext(ctx, `ALTER TABLE users ADD COLUMN nickname TEXT`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		log.Fatalf("Failed to migrate users.nickname schema: %v", err)
	}

	if _, err := db.ExecContext(ctx, `ALTER TABLE users ADD COLUMN avatar TEXT`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		log.Fatalf("Failed to migrate users.avatar schema: %v", err)
	}

	if _, err := db.ExecContext(ctx, `ALTER TABLE offline_messages ADD COLUMN msg_id TEXT`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		log.Fatalf("Failed to migrate offline_messages schema: %v", err)
	}

	if _, err := db.ExecContext(ctx, `ALTER TABLE users ADD COLUMN signed_prekey TEXT`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		log.Fatalf("Failed to migrate users.signed_prekey schema: %v", err)
	}

	if _, err := db.ExecContext(ctx, `ALTER TABLE users ADD COLUMN signed_prekey_sig TEXT`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		log.Fatalf("Failed to migrate users.signed_prekey_sig schema: %v", err)
	}

	if _, err := db.ExecContext(ctx, `ALTER TABLE users ADD COLUMN username TEXT`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		log.Fatalf("Failed to migrate users.username schema: %v", err)
	}
	if _, err := db.ExecContext(ctx, `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL`); err != nil {
		log.Fatalf("Failed to create index for users.username: %v", err)
	}
	if _, err := db.ExecContext(ctx, `ALTER TABLE group_invite_links ADD COLUMN expires_at DATETIME`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		log.Fatalf("Failed to migrate group_invite_links.expires_at schema: %v", err)
	}
	if _, err := db.ExecContext(ctx, `ALTER TABLE group_invite_links ADD COLUMN max_uses INTEGER`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		log.Fatalf("Failed to migrate group_invite_links.max_uses schema: %v", err)
	}
	if _, err := db.ExecContext(ctx, `ALTER TABLE group_invite_links ADD COLUMN uses_count INTEGER NOT NULL DEFAULT 0`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		log.Fatalf("Failed to migrate group_invite_links.uses_count schema: %v", err)
	}
	if _, err := db.ExecContext(ctx, `ALTER TABLE group_invite_links ADD COLUMN password_hash TEXT`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		log.Fatalf("Failed to migrate group_invite_links.password_hash schema: %v", err)
	}
	if _, err := db.ExecContext(ctx, `ALTER TABLE group_invite_links ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		log.Fatalf("Failed to migrate group_invite_links.revoked schema: %v", err)
	}
	if _, err := db.ExecContext(ctx, `ALTER TABLE channel_invite_links ADD COLUMN expires_at DATETIME`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		log.Fatalf("Failed to migrate channel_invite_links.expires_at schema: %v", err)
	}
	if _, err := db.ExecContext(ctx, `ALTER TABLE channel_invite_links ADD COLUMN max_uses INTEGER`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		log.Fatalf("Failed to migrate channel_invite_links.max_uses schema: %v", err)
	}
	if _, err := db.ExecContext(ctx, `ALTER TABLE channel_invite_links ADD COLUMN uses_count INTEGER NOT NULL DEFAULT 0`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		log.Fatalf("Failed to migrate channel_invite_links.uses_count schema: %v", err)
	}
	if _, err := db.ExecContext(ctx, `ALTER TABLE channel_invite_links ADD COLUMN password_hash TEXT`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		log.Fatalf("Failed to migrate channel_invite_links.password_hash schema: %v", err)
	}
	if _, err := db.ExecContext(ctx, `ALTER TABLE channel_invite_links ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
		log.Fatalf("Failed to migrate channel_invite_links.revoked schema: %v", err)
	}

	return &DB{db: db}
}

func (db *DB) Close() {
	if db.db != nil {
		db.db.Close()
	}
}

func (db *DB) Ping(ctx context.Context) error {
	return db.db.PingContext(ctx)
}

// SaveUserIfNotExists безопасно сохраняет пользователя, избегая ошибки уникальности.
func (db *DB) SaveUserIfNotExists(ctx context.Context, pubKey string) error {
	_, err := db.db.ExecContext(ctx, `
		INSERT INTO users (pub_key)
		VALUES (?)
		ON CONFLICT (pub_key) DO NOTHING;
	`, pubKey)
	return err
}

func (db *DB) SaveUserProfile(ctx context.Context, pubKey, nickname, avatar string, username *string) error {
	var err error
	if username != nil && *username != "" {
		// Update with username
		_, err = db.db.ExecContext(ctx, `
			INSERT INTO users (pub_key, nickname, avatar, username)
			VALUES (?, ?, ?, ?)
			ON CONFLICT (pub_key) DO UPDATE SET
				nickname = CASE
					WHEN excluded.nickname = '' THEN users.nickname
					ELSE excluded.nickname
				END,
				avatar = CASE
					WHEN excluded.avatar = '' THEN users.avatar
					ELSE excluded.avatar
				END,
				username = excluded.username;
		`, pubKey, strings.TrimSpace(nickname), strings.TrimSpace(avatar), strings.ToLower(strings.TrimSpace(*username)))
	} else if username != nil && *username == "" {
		// Clear username
		_, err = db.db.ExecContext(ctx, `
			INSERT INTO users (pub_key, nickname, avatar, username)
			VALUES (?, ?, ?, NULL)
			ON CONFLICT (pub_key) DO UPDATE SET
				nickname = CASE
					WHEN excluded.nickname = '' THEN users.nickname
					ELSE excluded.nickname
				END,
				avatar = CASE
					WHEN excluded.avatar = '' THEN users.avatar
					ELSE excluded.avatar
				END,
				username = NULL;
		`, pubKey, strings.TrimSpace(nickname), strings.TrimSpace(avatar))
	} else {
		// Keep existing username
		_, err = db.db.ExecContext(ctx, `
			INSERT INTO users (pub_key, nickname, avatar)
			VALUES (?, ?, ?)
			ON CONFLICT (pub_key) DO UPDATE SET
				nickname = CASE
					WHEN excluded.nickname = '' THEN users.nickname
					ELSE excluded.nickname
				END,
				avatar = CASE
					WHEN excluded.avatar = '' THEN users.avatar
					ELSE excluded.avatar
				END;
		`, pubKey, strings.TrimSpace(nickname), strings.TrimSpace(avatar))
	}
	return err
}

func (db *DB) GetUserProfile(ctx context.Context, pubKey string) (string, string, string, error) {
	var nickname sql.NullString
	var avatar sql.NullString
	var username sql.NullString
	err := db.db.QueryRowContext(ctx, `
		SELECT nickname, avatar, username
		FROM users
		WHERE pub_key = ?
	`, pubKey).Scan(&nickname, &avatar, &username)
	if err != nil {
		return "", "", "", err
	}

	return nickname.String, avatar.String, username.String, nil
}

// ResolveUsername looks up a user by their @username tag.
func (db *DB) ResolveUsername(ctx context.Context, username string) (string, string, string, error) {
	var pubKey sql.NullString
	var nickname sql.NullString
	var avatar sql.NullString

	err := db.db.QueryRowContext(ctx, `
		SELECT pub_key, nickname, avatar
		FROM users
		WHERE username = ?
	`, strings.ToLower(strings.TrimSpace(username))).Scan(&pubKey, &nickname, &avatar)

	if err != nil {
		return "", "", "", err
	}

	return pubKey.String, nickname.String, avatar.String, nil
}

func (db *DB) CreateGroup(ctx context.Context, id, title, avatar, ownerPubKey string, members []string) error {
	tx, err := db.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	ownerPubKey = strings.TrimSpace(ownerPubKey)
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO users (pub_key)
		VALUES (?)
		ON CONFLICT (pub_key) DO NOTHING
	`, ownerPubKey); err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO groups_meta (id, title, avatar, owner_pub_key)
		VALUES (?, ?, ?, ?)
	`, id, strings.TrimSpace(title), strings.TrimSpace(avatar), ownerPubKey); err != nil {
		return err
	}

	seenMembers := map[string]struct{}{ownerPubKey: {}}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO group_members (group_id, member_pub_key, role)
		VALUES (?, ?, 'owner')
	`, id, ownerPubKey); err != nil {
		return err
	}

	for _, member := range members {
		member = strings.TrimSpace(member)
		if member == "" {
			continue
		}
		if _, seen := seenMembers[member]; seen {
			continue
		}
		seenMembers[member] = struct{}{}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO users (pub_key)
			VALUES (?)
			ON CONFLICT (pub_key) DO NOTHING
		`, member); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO group_members (group_id, member_pub_key, role)
			VALUES (?, ?, 'member')
		`, id, member); err != nil {
			return err
		}
	}

	return tx.Commit()
}

func (db *DB) ListGroupsForUser(ctx context.Context, pubKey string) ([]GroupRecord, error) {
	groups := make([]GroupRecord, 0)
	rows, err := db.db.QueryContext(ctx, `
		SELECT g.id, g.title, COALESCE(g.avatar, ''), g.owner_pub_key, gm.role, g.created_at
		FROM groups_meta g
		INNER JOIN group_members gm ON gm.group_id = g.id
		WHERE gm.member_pub_key = ?
		ORDER BY g.created_at DESC
	`, pubKey)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var group GroupRecord
		if err := rows.Scan(&group.ID, &group.Title, &group.Avatar, &group.OwnerPubKey, &group.Role, &group.CreatedAt); err != nil {
			return nil, err
		}
		groups = append(groups, group)
	}
	return groups, rows.Err()
}

func (db *DB) GetGroupForUser(ctx context.Context, groupID, pubKey string) (GroupRecord, error) {
	var group GroupRecord
	err := db.db.QueryRowContext(ctx, `
		SELECT g.id, g.title, COALESCE(g.avatar, ''), g.owner_pub_key, gm.role, g.created_at
		FROM groups_meta g
		INNER JOIN group_members gm ON gm.group_id = g.id
		WHERE g.id = ? AND gm.member_pub_key = ?
	`, groupID, pubKey).Scan(&group.ID, &group.Title, &group.Avatar, &group.OwnerPubKey, &group.Role, &group.CreatedAt)
	return group, err
}

func (db *DB) ListGroupMembers(ctx context.Context, groupID string) ([]GroupMemberRecord, error) {
	members := make([]GroupMemberRecord, 0)
	rows, err := db.db.QueryContext(ctx, `
		SELECT group_id, member_pub_key, role, joined_at
		FROM group_members
		WHERE group_id = ?
		ORDER BY joined_at ASC
	`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var member GroupMemberRecord
		if err := rows.Scan(&member.GroupID, &member.MemberPubKey, &member.Role, &member.JoinedAt); err != nil {
			return nil, err
		}
		members = append(members, member)
	}
	return members, rows.Err()
}

func (db *DB) ListGroupMemberPubKeys(ctx context.Context, groupID string) ([]string, error) {
	members := make([]string, 0)
	rows, err := db.db.QueryContext(ctx, `
		SELECT member_pub_key
		FROM group_members
		WHERE group_id = ?
		ORDER BY joined_at ASC
	`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var pubKey string
		if err := rows.Scan(&pubKey); err != nil {
			return nil, err
		}
		members = append(members, pubKey)
	}
	return members, rows.Err()
}

func (db *DB) GetGroupMemberRole(ctx context.Context, groupID, pubKey string) (string, error) {
	var role string
	err := db.db.QueryRowContext(ctx, `
		SELECT role
		FROM group_members
		WHERE group_id = ? AND member_pub_key = ?
	`, groupID, pubKey).Scan(&role)
	return role, err
}

func (db *DB) AddGroupMember(ctx context.Context, groupID, memberPubKey string) error {
	_, err := db.db.ExecContext(ctx, `
		INSERT OR IGNORE INTO group_members (group_id, member_pub_key, role)
		VALUES (?, ?, 'member')
	`, groupID, memberPubKey)
	return err
}

func (db *DB) UpdateGroupMemberRole(ctx context.Context, groupID, memberPubKey, role string) error {
	_, err := db.db.ExecContext(ctx, `
		UPDATE group_members
		SET role = ?
		WHERE group_id = ? AND member_pub_key = ?
	`, strings.TrimSpace(role), groupID, memberPubKey)
	return err
}

func (db *DB) UpdateGroupMeta(ctx context.Context, groupID, title, avatar string) error {
	_, err := db.db.ExecContext(ctx, `
		UPDATE groups_meta
		SET title = ?, avatar = ?
		WHERE id = ?
	`, strings.TrimSpace(title), strings.TrimSpace(avatar), groupID)
	return err
}

func (db *DB) RemoveGroupMember(ctx context.Context, groupID, memberPubKey string) error {
	_, err := db.db.ExecContext(ctx, `
		DELETE FROM group_members
		WHERE group_id = ? AND member_pub_key = ?
	`, groupID, memberPubKey)
	return err
}

func (db *DB) TransferGroupOwnership(ctx context.Context, groupID, currentOwnerPubKey, newOwnerPubKey string) error {
	tx, err := db.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `
		UPDATE groups_meta
		SET owner_pub_key = ?
		WHERE id = ? AND owner_pub_key = ?
	`, newOwnerPubKey, groupID, currentOwnerPubKey); err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE group_members
		SET role = 'admin'
		WHERE group_id = ? AND member_pub_key = ? AND role = 'owner'
	`, groupID, currentOwnerPubKey); err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE group_members
		SET role = 'owner'
		WHERE group_id = ? AND member_pub_key = ?
	`, groupID, newOwnerPubKey); err != nil {
		return err
	}

	return tx.Commit()
}

func (db *DB) DeleteGroup(ctx context.Context, groupID, ownerPubKey string) error {
	_, err := db.db.ExecContext(ctx, `
		DELETE FROM groups_meta
		WHERE id = ? AND owner_pub_key = ?
	`, groupID, ownerPubKey)
	return err
}

func (db *DB) CreateChannel(ctx context.Context, id, title, avatar, ownerPubKey string) error {
	tx, err := db.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO channels (id, title, avatar, owner_pub_key)
		VALUES (?, ?, ?, ?)
	`, id, strings.TrimSpace(title), strings.TrimSpace(avatar), ownerPubKey); err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO channel_subscribers (channel_id, subscriber_pub_key, role)
		VALUES (?, ?, 'owner')
	`, id, ownerPubKey); err != nil {
		return err
	}

	return tx.Commit()
}

func (db *DB) ListChannelsForUser(ctx context.Context, pubKey string) ([]ChannelRecord, error) {
	channels := make([]ChannelRecord, 0)
	rows, err := db.db.QueryContext(ctx, `
		SELECT c.id, c.title, COALESCE(c.avatar, ''), c.owner_pub_key, cs.role, c.created_at
		FROM channels c
		INNER JOIN channel_subscribers cs ON cs.channel_id = c.id
		WHERE cs.subscriber_pub_key = ?
		ORDER BY c.created_at DESC
	`, pubKey)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var channel ChannelRecord
		if err := rows.Scan(&channel.ID, &channel.Title, &channel.Avatar, &channel.OwnerPubKey, &channel.Role, &channel.CreatedAt); err != nil {
			return nil, err
		}
		channels = append(channels, channel)
	}
	return channels, rows.Err()
}

func (db *DB) ListChannelSubscribers(ctx context.Context, channelID string) ([]ChannelSubscriberRecord, error) {
	subscribers := make([]ChannelSubscriberRecord, 0)
	rows, err := db.db.QueryContext(ctx, `
		SELECT channel_id, subscriber_pub_key, role, joined_at
		FROM channel_subscribers
		WHERE channel_id = ?
		ORDER BY joined_at ASC
	`, channelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var subscriber ChannelSubscriberRecord
		if err := rows.Scan(&subscriber.ChannelID, &subscriber.SubscriberPubKey, &subscriber.Role, &subscriber.JoinedAt); err != nil {
			return nil, err
		}
		subscribers = append(subscribers, subscriber)
	}
	return subscribers, rows.Err()
}

func (db *DB) ListChannelSubscriberPubKeys(ctx context.Context, channelID string) ([]string, error) {
	subscribers := make([]string, 0)
	rows, err := db.db.QueryContext(ctx, `
		SELECT subscriber_pub_key
		FROM channel_subscribers
		WHERE channel_id = ?
		ORDER BY joined_at ASC
	`, channelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var pubKey string
		if err := rows.Scan(&pubKey); err != nil {
			return nil, err
		}
		subscribers = append(subscribers, pubKey)
	}
	return subscribers, rows.Err()
}

func (db *DB) GetChannelSubscriberRole(ctx context.Context, channelID, pubKey string) (string, error) {
	var role string
	err := db.db.QueryRowContext(ctx, `
		SELECT role
		FROM channel_subscribers
		WHERE channel_id = ? AND subscriber_pub_key = ?
	`, channelID, pubKey).Scan(&role)
	return role, err
}

func (db *DB) AddChannelSubscriber(ctx context.Context, channelID, subscriberPubKey string) error {
	_, err := db.db.ExecContext(ctx, `
		INSERT OR IGNORE INTO channel_subscribers (channel_id, subscriber_pub_key, role)
		VALUES (?, ?, 'subscriber')
	`, channelID, subscriberPubKey)
	return err
}

func (db *DB) UpdateChannelSubscriberRole(ctx context.Context, channelID, subscriberPubKey, role string) error {
	_, err := db.db.ExecContext(ctx, `
		UPDATE channel_subscribers
		SET role = ?
		WHERE channel_id = ? AND subscriber_pub_key = ?
	`, strings.TrimSpace(role), channelID, subscriberPubKey)
	return err
}

func (db *DB) UpdateChannelMeta(ctx context.Context, channelID, title, avatar string) error {
	_, err := db.db.ExecContext(ctx, `
		UPDATE channels
		SET title = ?, avatar = ?
		WHERE id = ?
	`, strings.TrimSpace(title), strings.TrimSpace(avatar), channelID)
	return err
}

func (db *DB) RemoveChannelSubscriber(ctx context.Context, channelID, subscriberPubKey string) error {
	_, err := db.db.ExecContext(ctx, `
		DELETE FROM channel_subscribers
		WHERE channel_id = ? AND subscriber_pub_key = ?
	`, channelID, subscriberPubKey)
	return err
}

func (db *DB) TransferChannelOwnership(ctx context.Context, channelID, currentOwnerPubKey, newOwnerPubKey string) error {
	tx, err := db.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `
		UPDATE channels
		SET owner_pub_key = ?
		WHERE id = ? AND owner_pub_key = ?
	`, newOwnerPubKey, channelID, currentOwnerPubKey); err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE channel_subscribers
		SET role = 'admin'
		WHERE channel_id = ? AND subscriber_pub_key = ? AND role = 'owner'
	`, channelID, currentOwnerPubKey); err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE channel_subscribers
		SET role = 'owner'
		WHERE channel_id = ? AND subscriber_pub_key = ?
	`, channelID, newOwnerPubKey); err != nil {
		return err
	}

	return tx.Commit()
}

func (db *DB) DeleteChannel(ctx context.Context, channelID, ownerPubKey string) error {
	_, err := db.db.ExecContext(ctx, `
		DELETE FROM channels
		WHERE id = ? AND owner_pub_key = ?
	`, channelID, ownerPubKey)
	return err
}

func hashInvitePassword(password string) string {
	sum := sha256.Sum256([]byte(password))
	return hex.EncodeToString(sum[:])
}

func (db *DB) CreateGroupInviteLink(ctx context.Context, groupID, createdByPubKey string, expiresAt *time.Time, maxUses *int, password string) (string, error) {
	token, err := newEntityID("glnk")
	if err != nil {
		return "", err
	}
	var maxUsesValue any
	if maxUses != nil && *maxUses > 0 {
		maxUsesValue = *maxUses
	}
	var passwordHash any
	if strings.TrimSpace(password) != "" {
		passwordHash = hashInvitePassword(strings.TrimSpace(password))
	}

	_, err = db.db.ExecContext(ctx, `
		INSERT INTO group_invite_links (token, group_id, created_by_pub_key, expires_at, max_uses, uses_count, password_hash, revoked)
		VALUES (?, ?, ?, ?, ?, 0, ?, 0)
	`, token, groupID, createdByPubKey, expiresAt, maxUsesValue, passwordHash)
	if err != nil {
		return "", err
	}
	return token, nil
}

func (db *DB) CreateChannelInviteLink(ctx context.Context, channelID, createdByPubKey string, expiresAt *time.Time, maxUses *int, password string) (string, error) {
	token, err := newEntityID("clnk")
	if err != nil {
		return "", err
	}
	var maxUsesValue any
	if maxUses != nil && *maxUses > 0 {
		maxUsesValue = *maxUses
	}
	var passwordHash any
	if strings.TrimSpace(password) != "" {
		passwordHash = hashInvitePassword(strings.TrimSpace(password))
	}

	_, err = db.db.ExecContext(ctx, `
		INSERT INTO channel_invite_links (token, channel_id, created_by_pub_key, expires_at, max_uses, uses_count, password_hash, revoked)
		VALUES (?, ?, ?, ?, ?, 0, ?, 0)
	`, token, channelID, createdByPubKey, expiresAt, maxUsesValue, passwordHash)
	if err != nil {
		return "", err
	}
	return token, nil
}

func (db *DB) JoinGroupByInviteToken(ctx context.Context, token, memberPubKey, password string) (string, error) {
	tx, err := db.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()

	var groupID string
	var expiresAt sql.NullTime
	var maxUses sql.NullInt64
	var usesCount int
	var passwordHash sql.NullString
	var revoked int
	if err := tx.QueryRowContext(ctx, `
		SELECT group_id, expires_at, max_uses, uses_count, password_hash, revoked
		FROM group_invite_links
		WHERE token = ?
	`, strings.TrimSpace(token)).Scan(&groupID, &expiresAt, &maxUses, &usesCount, &passwordHash, &revoked); err != nil {
		return "", err
	}
	if revoked != 0 {
		return "", ErrInviteRevoked
	}
	if expiresAt.Valid && time.Now().After(expiresAt.Time) {
		return "", ErrInviteExpired
	}
	if maxUses.Valid && usesCount >= int(maxUses.Int64) {
		return "", ErrInviteUsageLimit
	}
	if passwordHash.Valid {
		normalized := strings.TrimSpace(password)
		if normalized == "" {
			return "", ErrInvitePasswordRequired
		}
		if hashInvitePassword(normalized) != passwordHash.String {
			return "", ErrInvitePasswordInvalid
		}
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO users (pub_key)
		VALUES (?)
		ON CONFLICT (pub_key) DO NOTHING
	`, memberPubKey); err != nil {
		return "", err
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT OR IGNORE INTO group_members (group_id, member_pub_key, role)
		VALUES (?, ?, 'member')
	`, groupID, memberPubKey); err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE group_invite_links
		SET uses_count = uses_count + 1
		WHERE token = ?
	`, strings.TrimSpace(token)); err != nil {
		return "", err
	}

	if err := tx.Commit(); err != nil {
		return "", err
	}
	return groupID, nil
}

func (db *DB) JoinChannelByInviteToken(ctx context.Context, token, subscriberPubKey, password string) (string, error) {
	tx, err := db.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()

	var channelID string
	var expiresAt sql.NullTime
	var maxUses sql.NullInt64
	var usesCount int
	var passwordHash sql.NullString
	var revoked int
	if err := tx.QueryRowContext(ctx, `
		SELECT channel_id, expires_at, max_uses, uses_count, password_hash, revoked
		FROM channel_invite_links
		WHERE token = ?
	`, strings.TrimSpace(token)).Scan(&channelID, &expiresAt, &maxUses, &usesCount, &passwordHash, &revoked); err != nil {
		return "", err
	}
	if revoked != 0 {
		return "", ErrInviteRevoked
	}
	if expiresAt.Valid && time.Now().After(expiresAt.Time) {
		return "", ErrInviteExpired
	}
	if maxUses.Valid && usesCount >= int(maxUses.Int64) {
		return "", ErrInviteUsageLimit
	}
	if passwordHash.Valid {
		normalized := strings.TrimSpace(password)
		if normalized == "" {
			return "", ErrInvitePasswordRequired
		}
		if hashInvitePassword(normalized) != passwordHash.String {
			return "", ErrInvitePasswordInvalid
		}
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO users (pub_key)
		VALUES (?)
		ON CONFLICT (pub_key) DO NOTHING
	`, subscriberPubKey); err != nil {
		return "", err
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT OR IGNORE INTO channel_subscribers (channel_id, subscriber_pub_key, role)
		VALUES (?, ?, 'subscriber')
	`, channelID, subscriberPubKey); err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE channel_invite_links
		SET uses_count = uses_count + 1
		WHERE token = ?
	`, strings.TrimSpace(token)); err != nil {
		return "", err
	}

	if err := tx.Commit(); err != nil {
		return "", err
	}
	return channelID, nil
}

func (db *DB) RevokeGroupInviteLink(ctx context.Context, groupID, token string) error {
	_, err := db.db.ExecContext(ctx, `UPDATE group_invite_links SET revoked = 1 WHERE group_id = ? AND token = ?`, groupID, strings.TrimSpace(token))
	return err
}

func (db *DB) RevokeChannelInviteLink(ctx context.Context, channelID, token string) error {
	_, err := db.db.ExecContext(ctx, `UPDATE channel_invite_links SET revoked = 1 WHERE channel_id = ? AND token = ?`, channelID, strings.TrimSpace(token))
	return err
}

func (db *DB) ListGroupInviteLinks(ctx context.Context, groupID string) ([]InviteLinkRecord, error) {
	rows, err := db.db.QueryContext(ctx, `
		SELECT token, group_id, created_by_pub_key, created_at, expires_at, max_uses, uses_count, password_hash, revoked
		FROM group_invite_links
		WHERE group_id = ?
		ORDER BY created_at DESC
	`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	records := make([]InviteLinkRecord, 0)
	for rows.Next() {
		var rec InviteLinkRecord
		rec.EntityType = "group"
		var expiresAt sql.NullTime
		var maxUses sql.NullInt64
		var passwordHash sql.NullString
		var revoked int
		if err := rows.Scan(&rec.Token, &rec.EntityID, &rec.CreatedByPubKey, &rec.CreatedAt, &expiresAt, &maxUses, &rec.UsesCount, &passwordHash, &revoked); err != nil {
			return nil, err
		}
		if expiresAt.Valid {
			t := expiresAt.Time
			rec.ExpiresAt = &t
		}
		if maxUses.Valid {
			v := int(maxUses.Int64)
			rec.MaxUses = &v
		}
		rec.HasPassword = passwordHash.Valid && passwordHash.String != ""
		rec.Revoked = revoked != 0
		records = append(records, rec)
	}
	return records, rows.Err()
}

func (db *DB) ListChannelInviteLinks(ctx context.Context, channelID string) ([]InviteLinkRecord, error) {
	rows, err := db.db.QueryContext(ctx, `
		SELECT token, channel_id, created_by_pub_key, created_at, expires_at, max_uses, uses_count, password_hash, revoked
		FROM channel_invite_links
		WHERE channel_id = ?
		ORDER BY created_at DESC
	`, channelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	records := make([]InviteLinkRecord, 0)
	for rows.Next() {
		var rec InviteLinkRecord
		rec.EntityType = "channel"
		var expiresAt sql.NullTime
		var maxUses sql.NullInt64
		var passwordHash sql.NullString
		var revoked int
		if err := rows.Scan(&rec.Token, &rec.EntityID, &rec.CreatedByPubKey, &rec.CreatedAt, &expiresAt, &maxUses, &rec.UsesCount, &passwordHash, &revoked); err != nil {
			return nil, err
		}
		if expiresAt.Valid {
			t := expiresAt.Time
			rec.ExpiresAt = &t
		}
		if maxUses.Valid {
			v := int(maxUses.Int64)
			rec.MaxUses = &v
		}
		rec.HasPassword = passwordHash.Valid && passwordHash.String != ""
		rec.Revoked = revoked != 0
		records = append(records, rec)
	}
	return records, rows.Err()
}

// SaveOfflineMessage сохраняет сообщение для оффлайн пользователя
func (db *DB) SaveOfflineMessage(ctx context.Context, senderPubKey, recipientPubKey string, payload []byte) error {
	msgID := extractMessageID(payload)
	var lastErr error
	for attempt := 0; attempt < 5; attempt++ {
		_, err := db.db.ExecContext(ctx, `
			INSERT OR IGNORE INTO offline_messages (sender_pub_key, recipient_pub_key, msg_id, payload)
			VALUES (?, ?, ?, ?);
		`, senderPubKey, recipientPubKey, msgID, payload)
		if err == nil {
			return nil
		}
		lastErr = err
		lowerErr := strings.ToLower(err.Error())
		if !strings.Contains(lowerErr, "database is locked") && !strings.Contains(lowerErr, "sqlite_busy") {
			return err
		}
		time.Sleep(time.Duration(attempt+1) * 25 * time.Millisecond)
	}
	return lastErr
}

// GetAndDeleteOfflineMessages возвращает все сообщения для пользователя и удаляет их из БД
func (db *DB) GetAndDeleteOfflineMessages(ctx context.Context, pubKey string) ([]*Message, error) {
	// Deliver in insertion order and delete only after the batch is read.
	tx, err := db.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	rows, err := tx.QueryContext(ctx, `
		SELECT id, sender_pub_key, recipient_pub_key, payload
		FROM offline_messages
		WHERE recipient_pub_key = ?
		ORDER BY id ASC
		LIMIT ?
	`, pubKey, offlineDeliveryBatchLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	ids := make([]any, 0)
	var messages []*Message
	for rows.Next() {
		var msg Message
		var id int64
		if err := rows.Scan(&id, &msg.SenderPubKey, &msg.RecipientPubKey, &msg.Payload); err != nil {
			return nil, err
		}
		ids = append(ids, id)
		messages = append(messages, &msg)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return messages, nil
	}

	placeholders := strings.TrimRight(strings.Repeat("?,", len(ids)), ",")
	if _, err := tx.ExecContext(ctx, fmt.Sprintf("DELETE FROM offline_messages WHERE id IN (%s)", placeholders), ids...); err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return messages, nil
}

// SavePreKeys сохраняет пачку пре-ключей пользователя
func (db *DB) SavePreKeys(ctx context.Context, userPubKey string, preKeys []string) error {
	tx, err := db.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	stmt, err := tx.Prepare("INSERT OR IGNORE INTO prekeys (user_pub_key, prekey_pub_key) VALUES (?, ?)")
	if err != nil {
		tx.Rollback()
		return err
	}
	defer stmt.Close()

	for _, pk := range preKeys {
		_, err = stmt.Exec(userPubKey, pk)
		if err != nil {
			tx.Rollback()
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM prekeys
		WHERE user_pub_key = ?
		  AND id NOT IN (
			SELECT id FROM prekeys
			WHERE user_pub_key = ?
			ORDER BY id DESC
			LIMIT 500
		  );
	`, userPubKey, userPubKey); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

// ConsumePreKey возвращает один пре-ключ пользователя и удаляет его (One-Time PreKey)
func (db *DB) ConsumePreKey(ctx context.Context, userPubKey string) (string, error) {
	var preKey string
	err := db.db.QueryRowContext(ctx, `
		DELETE FROM prekeys 
		WHERE id = (SELECT id FROM prekeys WHERE user_pub_key = ? LIMIT 1)
		RETURNING prekey_pub_key
	`, userPubKey).Scan(&preKey)

	if err == sql.ErrNoRows {
		return "", nil // Нет доступных пре-ключей
	}
	return preKey, err
}

func extractMessageID(payload []byte) string {
	var env struct {
		MsgID string `json:"msg_id"`
	}
	if err := json.Unmarshal(payload, &env); err != nil {
		return ""
	}
	return env.MsgID
}

// SaveSignedPreKey saves the user's active Signed PreKey and its signature
func (db *DB) SaveSignedPreKey(ctx context.Context, pubKey, spk, sig string) error {
	_, err := db.db.ExecContext(ctx, `
		UPDATE users
		SET signed_prekey = ?, signed_prekey_sig = ?
		WHERE pub_key = ?
	`, spk, sig, pubKey)
	return err
}

// GetSignedPreKey retrieves the user's active Signed PreKey and its signature
func (db *DB) GetSignedPreKey(ctx context.Context, pubKey string) (string, string, error) {
	var spk sql.NullString
	var sig sql.NullString
	err := db.db.QueryRowContext(ctx, `
		SELECT signed_prekey, signed_prekey_sig
		FROM users
		WHERE pub_key = ?
	`, pubKey).Scan(&spk, &sig)
	if err != nil && err != sql.ErrNoRows {
		return "", "", err
	}
	return spk.String, sig.String, nil
}

func (db *DB) InsertModerationAudit(ctx context.Context, entityType, entityID, actorPubKey, action, target, details string) error {
	_, err := db.db.ExecContext(ctx, `
		INSERT INTO moderation_audit (entity_type, entity_id, actor_pub_key, action, target, details)
		VALUES (?, ?, ?, ?, ?, ?)
	`, strings.TrimSpace(entityType), strings.TrimSpace(entityID), strings.TrimSpace(actorPubKey), strings.TrimSpace(action), strings.TrimSpace(target), strings.TrimSpace(details))
	return err
}

func (db *DB) ListModerationAudit(ctx context.Context, entityType, entityID string, limit int) ([]ModerationAuditRecord, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	rows, err := db.db.QueryContext(ctx, `
		SELECT id, entity_type, entity_id, actor_pub_key, action, target, details, created_at
		FROM moderation_audit
		WHERE entity_type = ? AND entity_id = ?
		ORDER BY created_at DESC
		LIMIT ?
	`, strings.TrimSpace(entityType), strings.TrimSpace(entityID), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]ModerationAuditRecord, 0, limit)
	for rows.Next() {
		var rec ModerationAuditRecord
		if err := rows.Scan(&rec.ID, &rec.EntityType, &rec.EntityID, &rec.ActorPubKey, &rec.Action, &rec.Target, &rec.Details, &rec.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}

func (db *DB) SaveSessionToken(ctx context.Context, record SessionTokenRecord) error {
	if strings.TrimSpace(record.Token) == "" || strings.TrimSpace(record.PubKey) == "" {
		return fmt.Errorf("missing session token fields")
	}
	if err := db.SaveUserIfNotExists(ctx, record.PubKey); err != nil {
		return err
	}
	_, err := db.db.ExecContext(ctx, `
		INSERT INTO session_tokens (token, pub_key, created_at, last_seen, expires_at, user_agent, remote_ip)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (token) DO UPDATE SET
			pub_key = excluded.pub_key,
			created_at = excluded.created_at,
			last_seen = excluded.last_seen,
			expires_at = excluded.expires_at,
			user_agent = excluded.user_agent,
			remote_ip = excluded.remote_ip
	`, record.Token, record.PubKey, record.CreatedAt.UTC(), record.LastSeen.UTC(), record.ExpiresAt.UTC(), strings.TrimSpace(record.UserAgent), strings.TrimSpace(record.RemoteIP))
	return err
}

func (db *DB) GetSessionToken(ctx context.Context, token string) (SessionTokenRecord, error) {
	var record SessionTokenRecord
	err := db.db.QueryRowContext(ctx, `
		SELECT token, pub_key, created_at, last_seen, expires_at, user_agent, remote_ip
		FROM session_tokens
		WHERE token = ?
	`, strings.TrimSpace(token)).Scan(&record.Token, &record.PubKey, &record.CreatedAt, &record.LastSeen, &record.ExpiresAt, &record.UserAgent, &record.RemoteIP)
	return record, err
}

func (db *DB) TouchSessionToken(ctx context.Context, token string, lastSeen time.Time) error {
	_, err := db.db.ExecContext(ctx, `
		UPDATE session_tokens
		SET last_seen = ?
		WHERE token = ?
	`, lastSeen.UTC(), strings.TrimSpace(token))
	return err
}

func (db *DB) DeleteSessionToken(ctx context.Context, token string) error {
	_, err := db.db.ExecContext(ctx, `DELETE FROM session_tokens WHERE token = ?`, strings.TrimSpace(token))
	return err
}

func (db *DB) DeleteAllSessionTokensForUser(ctx context.Context, pubKey, exceptToken string) (int64, error) {
	result, err := db.db.ExecContext(ctx, `
		DELETE FROM session_tokens
		WHERE pub_key = ? AND token <> ?
	`, strings.TrimSpace(pubKey), strings.TrimSpace(exceptToken))
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func (db *DB) ListSessionTokens(ctx context.Context, pubKey string) ([]SessionTokenRecord, error) {
	rows, err := db.db.QueryContext(ctx, `
		SELECT token, pub_key, created_at, last_seen, expires_at, user_agent, remote_ip
		FROM session_tokens
		WHERE pub_key = ?
		ORDER BY created_at DESC
	`, strings.TrimSpace(pubKey))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]SessionTokenRecord, 0)
	for rows.Next() {
		var record SessionTokenRecord
		if err := rows.Scan(&record.Token, &record.PubKey, &record.CreatedAt, &record.LastSeen, &record.ExpiresAt, &record.UserAgent, &record.RemoteIP); err != nil {
			return nil, err
		}
		out = append(out, record)
	}
	return out, rows.Err()
}

func (db *DB) CleanupExpiredSessionTokens(ctx context.Context, now time.Time) error {
	_, err := db.db.ExecContext(ctx, `DELETE FROM session_tokens WHERE expires_at <= ?`, now.UTC())
	return err
}

func (db *DB) SaveFileToken(ctx context.Context, token, filename string, expiresAt time.Time) error {
	_, err := db.db.ExecContext(ctx, `
		INSERT INTO file_tokens (token, filename, expires_at)
		VALUES (?, ?, ?)
		ON CONFLICT (token) DO UPDATE SET
			filename = excluded.filename,
			expires_at = excluded.expires_at
	`, strings.TrimSpace(token), strings.TrimSpace(filename), expiresAt.UTC())
	return err
}

func (db *DB) GetFileToken(ctx context.Context, token string) (FileTokenRecord, error) {
	var record FileTokenRecord
	err := db.db.QueryRowContext(ctx, `
		SELECT token, filename, expires_at
		FROM file_tokens
		WHERE token = ?
	`, strings.TrimSpace(token)).Scan(&record.Token, &record.Filename, &record.ExpiresAt)
	return record, err
}

func (db *DB) DeleteFileToken(ctx context.Context, token string) error {
	_, err := db.db.ExecContext(ctx, `DELETE FROM file_tokens WHERE token = ?`, strings.TrimSpace(token))
	return err
}

func (db *DB) CleanupExpiredFileTokens(ctx context.Context, now time.Time) error {
	_, err := db.db.ExecContext(ctx, `DELETE FROM file_tokens WHERE expires_at <= ?`, now.UTC())
	return err
}

func (db *DB) ReplaceFileAccess(ctx context.Context, filename string, allowedPubKeys []string) error {
	tx, err := db.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	filename = strings.TrimSpace(filename)
	if filename == "" {
		return fmt.Errorf("missing filename")
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM file_access WHERE filename = ?`, filename); err != nil {
		return err
	}
	seen := make(map[string]struct{}, len(allowedPubKeys))
	for _, pubKey := range allowedPubKeys {
		pubKey = strings.TrimSpace(pubKey)
		if pubKey == "" {
			continue
		}
		if _, ok := seen[pubKey]; ok {
			continue
		}
		seen[pubKey] = struct{}{}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO users (pub_key)
			VALUES (?)
			ON CONFLICT (pub_key) DO NOTHING
		`, pubKey); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO file_access (filename, pub_key)
			VALUES (?, ?)
			ON CONFLICT (filename, pub_key) DO NOTHING
		`, filename, pubKey); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (db *DB) HasFileAccess(ctx context.Context, filename, pubKey string) (bool, error) {
	var exists int
	err := db.db.QueryRowContext(ctx, `
		SELECT 1
		FROM file_access
		WHERE filename = ? AND pub_key = ?
		LIMIT 1
	`, strings.TrimSpace(filename), strings.TrimSpace(pubKey)).Scan(&exists)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}
