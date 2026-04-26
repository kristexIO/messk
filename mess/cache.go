package main

import (
	"context"
	"sync"
)

type Cache struct {
	statuses sync.Map
}

func InitCache() *Cache {
	return &Cache{}
}

func (c *Cache) Close() error {
	// In-memory cache doesn't need to be explicitly closed
	return nil
}

// SetOnlineStatus обновляет статус пользователя во внутреннем in-memory кэше.
func (c *Cache) SetOnlineStatus(ctx context.Context, pubKey string, online bool) error {
	if online {
		c.statuses.Store(pubKey, true)
	} else {
		c.statuses.Delete(pubKey)
	}
	return nil
}

// IsOnline проверяет статус пользователя (может пригодиться в будущем)
func (c *Cache) IsOnline(pubKey string) bool {
	_, ok := c.statuses.Load(pubKey)
	return ok
}
