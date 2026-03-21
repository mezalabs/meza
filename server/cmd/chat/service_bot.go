package main

import (
	"context"
	"errors"

	"connectrpc.com/connect"

	mezav1 "github.com/mezalabs/meza/gen/meza/v1"
)

func (s *chatService) CreateBot(ctx context.Context, req *connect.Request[mezav1.CreateBotRequest]) (*connect.Response[mezav1.CreateBotResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("not yet implemented"))
}

func (s *chatService) DeleteBot(ctx context.Context, req *connect.Request[mezav1.DeleteBotRequest]) (*connect.Response[mezav1.DeleteBotResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("not yet implemented"))
}

func (s *chatService) RegenerateBotToken(ctx context.Context, req *connect.Request[mezav1.RegenerateBotTokenRequest]) (*connect.Response[mezav1.RegenerateBotTokenResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("not yet implemented"))
}

func (s *chatService) ListBots(ctx context.Context, req *connect.Request[mezav1.ListBotsRequest]) (*connect.Response[mezav1.ListBotsResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("not yet implemented"))
}

func (s *chatService) GetBot(ctx context.Context, req *connect.Request[mezav1.GetBotRequest]) (*connect.Response[mezav1.GetBotResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("not yet implemented"))
}

func (s *chatService) AddBotToServer(ctx context.Context, req *connect.Request[mezav1.AddBotToServerRequest]) (*connect.Response[mezav1.AddBotToServerResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("not yet implemented"))
}

func (s *chatService) RemoveBotFromServer(ctx context.Context, req *connect.Request[mezav1.RemoveBotFromServerRequest]) (*connect.Response[mezav1.RemoveBotFromServerResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("not yet implemented"))
}

func (s *chatService) CreateWebhook(ctx context.Context, req *connect.Request[mezav1.CreateWebhookRequest]) (*connect.Response[mezav1.CreateWebhookResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("not yet implemented"))
}

func (s *chatService) DeleteWebhook(ctx context.Context, req *connect.Request[mezav1.DeleteWebhookRequest]) (*connect.Response[mezav1.DeleteWebhookResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("not yet implemented"))
}

func (s *chatService) ListWebhooks(ctx context.Context, req *connect.Request[mezav1.ListWebhooksRequest]) (*connect.Response[mezav1.ListWebhooksResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("not yet implemented"))
}
