package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type DB struct {
	db *sql.DB
}

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

func InitDB(ctx context.Context, dataSourceName string) *DB {
	db, err := sql.Open("sqlite", dataSourceName)
	if err != nil {
		log.Fatalf("Unable to open database: %v", err)
	}

	// Проверяем подключение
	if err := db.Ping(); err != nil {
		log.Fatalf("Unable to connect to database: %v", err)
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

		-- Performance Indexes
		CREATE INDEX IF NOT EXISTS idx_offline_recipient ON offline_messages(recipient_pub_key);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_offline_recipient_msg_id ON offline_messages(recipient_pub_key, msg_id) WHERE msg_id IS NOT NULL;
		CREATE INDEX IF NOT EXISTS idx_prekeys_user ON prekeys(user_pub_key);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_prekeys_user_prekey ON prekeys(user_pub_key, prekey_pub_key);
		CREATE INDEX IF NOT EXISTS idx_group_members_member ON group_members(member_pub_key);
		CREATE INDEX IF NOT EXISTS idx_channel_subscribers_member ON channel_subscribers(subscriber_pub_key);
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

func (db *DB) SaveUserProfile(ctx context.Context, pubKey, nickname, avatar string) error {
	_, err := db.db.ExecContext(ctx, `
		INSERT INTO users (pub_key, nickname, avatar)
		VALUES (?, ?, ?)
		ON CONFLICT (pub_key) DO UPDATE SET
			nickname = excluded.nickname,
			avatar = excluded.avatar;
	`, pubKey, strings.TrimSpace(nickname), strings.TrimSpace(avatar))
	return err
}

func (db *DB) GetUserProfile(ctx context.Context, pubKey string) (string, string, error) {
	var nickname sql.NullString
	var avatar sql.NullString
	err := db.db.QueryRowContext(ctx, `
		SELECT nickname, avatar
		FROM users
		WHERE pub_key = ?
	`, pubKey).Scan(&nickname, &avatar)
	if err != nil {
		return "", "", err
	}

	return nickname.String, avatar.String, nil
}

func (db *DB) CreateGroup(ctx context.Context, id, title, avatar, ownerPubKey string, members []string) error {
	tx, err := db.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

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
	// В SQLite RETURNING поддерживается в последних версиях (с 3.35.0, что в modernc.org/sqlite поддерживается)
	rows, err := db.db.QueryContext(ctx, `
		DELETE FROM offline_messages 
		WHERE recipient_pub_key = ?
		RETURNING sender_pub_key, recipient_pub_key, payload
	`, pubKey)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var messages []*Message
	for rows.Next() {
		var msg Message
		if err := rows.Scan(&msg.SenderPubKey, &msg.RecipientPubKey, &msg.Payload); err != nil {
			return nil, err
		}
		messages = append(messages, &msg)
	}
	return messages, rows.Err()
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
