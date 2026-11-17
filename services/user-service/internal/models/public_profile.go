package models

// PublicProfile is the only shape in which one account is shown to another:
// GET /users/:id for anyone but the owner and its linked accounts, and every
// row of /users/search and /users/discover except the caller's own.
//
// It is its own type, not a UserProfile with fields blanked: a field added to
// UserProfile later never reaches other people unless someone adds it here on
// purpose. Until Nov 12 2026 the blanked copy still sent "email": "",
// "twoFactorEnabled", "twoFactorMethod" and the real isManagedAccount of every
// user in search and discover.
//
// Every field here is read by the app on someone else's profile, a search row,
// a suggestion card, a chat header or a mention (wt-integracion, Nov 12 2026).
// bookingEmail stays: it is the contact a creator publishes on purpose, shown
// as the mail button of the public profile. It is not the login email.
// isFollowing is not here because user-service does not know it; the app takes
// it from social-service (/users/:id/stats).
type PublicProfile struct {
	ID              uint64   `json:"id"`
	Username        string   `json:"username"`
	DisplayName     string   `json:"displayName"`
	Avatar          *string  `json:"avatar,omitempty"`
	Bio             *string  `json:"bio,omitempty"`
	Role            string   `json:"role"`
	CreatorTypes    []string `json:"creatorTypes,omitempty"`
	CreatorGenres   []string `json:"creatorGenres,omitempty"`
	ProfileVerified bool     `json:"profileVerified"`

	SocialInstagram  *string `json:"socialInstagram,omitempty"`
	SocialTiktok     *string `json:"socialTiktok,omitempty"`
	SocialYoutube    *string `json:"socialYoutube,omitempty"`
	SocialSoundcloud *string `json:"socialSoundcloud,omitempty"`
	SocialSpotify    *string `json:"socialSpotify,omitempty"`
	SocialTwitter    *string `json:"socialTwitter,omitempty"`
	Website          *string `json:"website,omitempty"`
	Location         *string `json:"location,omitempty"`
	RecordLabel      *string `json:"recordLabel,omitempty"`
	BookingEmail     *string `json:"bookingEmail,omitempty"`

	FollowersCount int64  `json:"followersCount"`
	FollowingCount int64  `json:"followingCount"`
	PostsCount     int64  `json:"postsCount"`
	CreatedAt      string `json:"createdAt"`
}

// Public returns the profile as anyone may see it. The owner and its linked
// accounts get the full UserProfile instead (see the user handler).
func (p *UserProfile) Public() *PublicProfile {
	if p == nil {
		return nil
	}
	return &PublicProfile{
		ID:               p.ID,
		Username:         p.Username,
		DisplayName:      p.DisplayName,
		Avatar:           p.Avatar,
		Bio:              p.Bio,
		Role:             p.Role,
		CreatorTypes:     p.CreatorTypes,
		CreatorGenres:    p.CreatorGenres,
		ProfileVerified:  p.ProfileVerified,
		SocialInstagram:  p.SocialInstagram,
		SocialTiktok:     p.SocialTiktok,
		SocialYoutube:    p.SocialYoutube,
		SocialSoundcloud: p.SocialSoundcloud,
		SocialSpotify:    p.SocialSpotify,
		SocialTwitter:    p.SocialTwitter,
		Website:          p.Website,
		Location:         p.Location,
		RecordLabel:      p.RecordLabel,
		BookingEmail:     p.BookingEmail,
		FollowersCount:   p.FollowersCount,
		FollowingCount:   p.FollowingCount,
		PostsCount:       p.PostsCount,
		CreatedAt:        p.CreatedAt,
	}
}
