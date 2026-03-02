package grpc

import (
	"context"
	"fmt"
	"log"
	"net"
	"strconv"

	"github.com/atto-sound/user-service/internal/middleware"
	"github.com/atto-sound/user-service/internal/models"
	"github.com/atto-sound/user-service/internal/services"
	grpclib "google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/reflection"
	"google.golang.org/grpc/status"
)

const errUserIDRequired = "user_id is required"

// UserGRPCServer implements the UserService gRPC server.
type UserGRPCServer struct {
	UnimplementedUserServiceServer
	userService *services.UserService
	jwtMgr      *middleware.JWTManager
}

// NewUserGRPCServer creates a new gRPC server instance.
func NewUserGRPCServer(userService *services.UserService, jwtMgr *middleware.JWTManager) *UserGRPCServer {
	return &UserGRPCServer{
		userService: userService,
		jwtMgr:      jwtMgr,
	}
}

// Start starts the gRPC server on the given port. This method blocks.
func (s *UserGRPCServer) Start(port string) error {
	lis, err := net.Listen("tcp", ":"+port)
	if err != nil {
		return fmt.Errorf("failed to listen on port %s: %w", port, err)
	}

	grpcServer := grpclib.NewServer()
	RegisterUserServiceServer(grpcServer, s)
	reflection.Register(grpcServer)

	log.Printf("[gRPC] Server listening on port %s", port)
	return grpcServer.Serve(lis)
}

// GetUser implements the GetUser RPC.
func (s *UserGRPCServer) GetUser(ctx context.Context, req *GetUserRequest) (*UserResponse, error) {
	if req.UserId == "" {
		return nil, status.Error(codes.InvalidArgument, errUserIDRequired)
	}

	profile, err := s.userService.GetUserByID(ctx, req.UserId)
	if err != nil {
		if err.Error() == "user not found" {
			return nil, status.Error(codes.NotFound, "user not found")
		}
		return nil, status.Error(codes.Internal, err.Error())
	}

	return profileToGRPC(profile), nil
}

// GetUsersBatch implements the GetUsersBatch RPC.
func (s *UserGRPCServer) GetUsersBatch(ctx context.Context, req *GetUsersBatchRequest) (*GetUsersBatchResponse, error) {
	if len(req.UserIds) == 0 {
		return &GetUsersBatchResponse{Users: []*UserResponse{}}, nil
	}

	profiles, err := s.userService.GetUsersByIDs(ctx, req.UserIds)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	users := make([]*UserResponse, 0, len(profiles))
	for _, p := range profiles {
		users = append(users, profileToGRPC(p))
	}

	return &GetUsersBatchResponse{Users: users}, nil
}

// ValidateToken implements the ValidateToken RPC.
func (s *UserGRPCServer) ValidateToken(ctx context.Context, req *ValidateTokenRequest) (*ValidateTokenResponse, error) {
	if req.Token == "" {
		return &ValidateTokenResponse{Valid: false}, nil
	}

	claims, err := s.jwtMgr.ValidateToken(req.Token)
	if err != nil {
		return &ValidateTokenResponse{Valid: false}, nil
	}

	return &ValidateTokenResponse{
		Valid:  true,
		UserId: claims.UserID,
		Role:   claims.Role,
	}, nil
}

// VerifyUserForContentUpload implements the VerifyUserForContentUpload RPC.
func (s *UserGRPCServer) VerifyUserForContentUpload(ctx context.Context, req *VerificationRequest) (*VerificationResponse, error) {
	if req.UserId == "" {
		return nil, status.Error(codes.InvalidArgument, errUserIDRequired)
	}

	verified, allowedTypes, err := s.userService.VerifyUser(ctx, req.UserId, req.InmateNumber)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &VerificationResponse{
		IsVerified:          verified,
		AllowedContentTypes: allowedTypes,
	}, nil
}

// GetUserContentPermissions implements the GetUserContentPermissions RPC.
func (s *UserGRPCServer) GetUserContentPermissions(ctx context.Context, req *PermissionRequest) (*PermissionResponse, error) {
	if req.UserId == "" {
		return nil, status.Error(codes.InvalidArgument, errUserIDRequired)
	}

	canUpload, allowedTypes, maxSize, err := s.userService.GetContentPermissions(ctx, req.UserId)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	return &PermissionResponse{
		CanUpload:           canUpload,
		AllowedContentTypes: allowedTypes,
		MaxFileSizeBytes:    maxSize,
	}, nil
}

// profileToGRPC converts a UserProfile DTO to a gRPC UserResponse.
func profileToGRPC(p *models.UserProfile) *UserResponse {
	resp := &UserResponse{
		Id:              strconv.FormatUint(p.ID, 10),
		Username:        p.Username,
		DisplayName:     p.DisplayName,
		Role:            p.Role,
		ProfileVerified: p.ProfileVerified,
		FollowersCount:  p.FollowersCount,
		FollowingCount:  p.FollowingCount,
		PostsCount:      p.PostsCount,
		CreatedAt:       p.CreatedAt,
	}
	if p.Avatar != nil {
		resp.Avatar = p.Avatar
	}
	if p.Bio != nil {
		resp.Bio = p.Bio
	}
	if p.InmateNumber != nil {
		resp.InmateNumber = p.InmateNumber
	}
	if p.RepresentativeID != nil {
		s := strconv.FormatUint(*p.RepresentativeID, 10)
		resp.RepresentativeId = &s
	}
	return resp
}
