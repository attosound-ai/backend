package models

import "time"

// PushToken stores Expo push notification tokens per user/device.
// Composite unique on (user_id, token) allows the same device token
// to be mapped to multiple accounts (multi-account support).
type PushToken struct {
	ID        uint64    `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID    uint64    `gorm:"uniqueIndex:idx_user_token;not null" json:"userId"`
	Token     string    `gorm:"size:255;uniqueIndex:idx_user_token;index:idx_push_token;not null" json:"token"`
	DeviceID  string    `gorm:"size:255;not null" json:"deviceId"`
	Platform  string    `gorm:"size:10;not null" json:"platform"` // "ios" or "android"
	IsActive  bool      `gorm:"default:true" json:"isActive"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}
