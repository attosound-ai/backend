package models

import "time"

// UserAppIconPreference stores the user's selected home-screen app icon.
//
// Why a row at all (vs a column on `users`): the catalog of available icons
// lives in content-service / Mongo and is rotated more frequently than
// `users` rows are mutated. Keeping it in its own table avoids touching
// the heavily-read `users` table and lets us add per-device preferences
// in a future iteration without another migration.
//
// `slot_name` is the contract with the mobile binary — it MUST match a
// slot declared in the app's `@howincodes/expo-dynamic-app-icon` plugin
// config. Absence of a row (or empty `slot_name`) means "primary icon".
type UserAppIconPreference struct {
	ID         uint64    `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID     uint64    `gorm:"uniqueIndex;not null" json:"userId"`
	SlotName   string    `gorm:"size:64;not null" json:"slotName"`
	UpdatedAt  time.Time `json:"updatedAt"`
	SelectedAt time.Time `json:"selectedAt"`
}

// TableName overrides the default plural to be explicit.
func (UserAppIconPreference) TableName() string {
	return "user_app_icon_preferences"
}
