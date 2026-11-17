package models

import "time"

// Estados de una petición de borrado con gracia.
const (
	// DeletionRequestPending: la cuenta está desactivada y espera su fecha.
	DeletionRequestPending = "pending"
	// DeletionRequestRecovered: la persona volvió y recuperó la cuenta.
	DeletionRequestRecovered = "recovered"
	// DeletionRequestExecuted: el barrido la borró de verdad (hay fila en
	// account_deletions con el mismo batch).
	DeletionRequestExecuted = "executed"
	// DeletionRequestSuperseded: un operador la borró antes de la fecha con
	// el borrado inmediato de soporte.
	DeletionRequestSuperseded = "superseded"
)

// DefaultDeletionGrace son los 30 días que pidió el cliente (28 oct 2026,
// "como en Snapchat").
const DefaultDeletionGrace = 30 * 24 * time.Hour

// AccountDeletionRequest es una petición de borrado que todavía se puede
// deshacer. Una fila por cuenta; las que se pidieron juntas (una
// representante con sus creators) comparten BatchID y se recuperan o se
// borran juntas.
//
// Nunca se borra: queda como historia de quién pidió qué y qué pasó después.
// Sin clave foránea a users a propósito, como account_deletions: cuando el
// barrido termina, la fila del usuario ya no existe.
type AccountDeletionRequest struct {
	ID      uint64 `gorm:"primaryKey;autoIncrement" json:"id"`
	BatchID string `gorm:"size:36;index;not null" json:"batchId"`
	UserID  uint64 `gorm:"index;not null" json:"userId"`
	// Username en el momento de pedirlo, para la lista del panel.
	Username string `gorm:"size:50;not null" json:"username"`
	// IncludedAsLinked: entró porque su cuenta vinculada pidió borrar
	// también las vinculadas.
	IncludedAsLinked bool `json:"includedAsLinked"`
	// DeleteLinked lo marca la fila de la cuenta que hizo la petición.
	DeleteLinked bool `json:"deleteLinked"`

	Via         string  `gorm:"size:20;not null" json:"via"`
	RequestedBy string  `gorm:"size:200;not null" json:"requestedBy"`
	PerformedBy string  `gorm:"size:200;not null" json:"performedBy"`
	Reason      string  `gorm:"size:1000" json:"reason"`
	ActorUserID *uint64 `json:"actorUserId,omitempty"`
	ClientIP    string  `gorm:"size:64" json:"clientIp,omitempty"`
	UserAgent   string  `gorm:"size:300" json:"userAgent,omitempty"`
	// Locale del aviso por correo (en, es, pt-BR).
	Locale string `gorm:"size:10" json:"locale,omitempty"`

	Status       string    `gorm:"size:20;index;not null" json:"status"`
	RequestedAt  time.Time `gorm:"not null" json:"requestedAt"`
	ScheduledFor time.Time `gorm:"index;not null" json:"scheduledFor"`
	// ResolvedAt y ResolvedBy: cuándo y quién la sacó de pending (la
	// persona al recuperar, el barrido, o el operador).
	ResolvedAt *time.Time `json:"resolvedAt,omitempty"`
	ResolvedBy string     `gorm:"size:200" json:"resolvedBy,omitempty"`
}

// TableName fija el nombre de la tabla.
func (AccountDeletionRequest) TableName() string { return "account_deletion_requests" }
