package connectapi

import (
	"testing"

	"connectrpc.com/connect"

	"hmans.de/chatto/internal/core"
	apiv1 "hmans.de/chatto/internal/pb/chatto/api/v1"
)

func TestMessageActionsCreateInvokeListAndAcknowledge(t *testing.T) {
	env := newConnectAPITestEnv(t)
	room := env.createJoinedRoom("message-actions")
	actions := &apiv1.MessageActionSet{Actions: []*apiv1.MessageAction{
		{Id: "hit", Label: "Hit", Style: apiv1.MessageActionStyle_MESSAGE_ACTION_STYLE_PRIMARY},
		{Id: "stand", Label: "Stand", Style: apiv1.MessageActionStyle_MESSAGE_ACTION_STYLE_DANGER, Disabled: true},
		{Id: "double", Label: "Double", Style: apiv1.MessageActionStyle_MESSAGE_ACTION_STYLE_SUCCESS},
	}}
	created, err := env.messages.CreateMessage(withCaller(env.ctx, env.viewer), connect.NewRequest(&apiv1.CreateMessageRequest{
		RoomId:  room.GetId(),
		Actions: actions,
	}))
	if err != nil {
		t.Fatalf("CreateMessage with actions: %v", err)
	}
	message := created.Msg.GetMessage()
	if message.GetBody() != "" || len(message.GetActions()) != 3 || message.GetActions()[0].GetId() != "hit" {
		t.Fatalf("created message = %+v, want action-only message with ordered actions", message)
	}

	member, err := env.core.CreateUser(env.ctx, core.SystemActorID, "action-member", "Action Member", "password")
	if err != nil {
		t.Fatalf("CreateUser member: %v", err)
	}
	request := &apiv1.InvokeMessageActionRequest{
		RoomId:         room.GetId(),
		MessageEventId: message.GetId(),
		ActionId:       "hit",
		RequestId:      "request_12345678",
	}
	if _, err := env.messageActions.InvokeMessageAction(withCaller(env.ctx, member), connect.NewRequest(request)); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("non-member InvokeMessageAction code = %v, want permission_denied", connect.CodeOf(err))
	}
	if _, err := env.core.JoinRoom(env.ctx, member.GetId(), core.KindChannel, member.GetId(), room.GetId()); err != nil {
		t.Fatalf("JoinRoom member: %v", err)
	}
	if _, err := env.messageActions.InvokeMessageAction(env.ctx, connect.NewRequest(request)); connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("unauthenticated InvokeMessageAction code = %v, want unauthenticated", connect.CodeOf(err))
	}
	disabled := *request
	disabled.ActionId = "stand"
	disabled.RequestId = "request_87654321"
	if _, err := env.messageActions.InvokeMessageAction(withCaller(env.ctx, member), connect.NewRequest(&disabled)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("disabled InvokeMessageAction code = %v, want failed_precondition", connect.CodeOf(err))
	}

	first, err := env.messageActions.InvokeMessageAction(withCaller(env.ctx, member), connect.NewRequest(request))
	if err != nil {
		t.Fatalf("InvokeMessageAction: %v", err)
	}
	invocation := first.Msg.GetInvocation()
	if invocation.GetId() != request.RequestId || invocation.GetActorId() != member.GetId() || invocation.GetMessageEventId() != message.GetId() || invocation.GetActionId() != "hit" {
		t.Fatalf("invocation = %+v", invocation)
	}
	if _, err := env.messages.UpdateMessage(withCaller(env.ctx, env.viewer), connect.NewRequest(&apiv1.UpdateMessageRequest{
		RoomId:  room.GetId(),
		EventId: message.GetId(),
		Actions: &apiv1.MessageActionSet{Actions: []*apiv1.MessageAction{
			{Id: "hit", Label: "Hit", Disabled: true},
			{Id: "double", Label: "Double"},
		}},
	})); err != nil {
		t.Fatalf("disable invoked action: %v", err)
	}
	retried, err := env.messageActions.InvokeMessageAction(withCaller(env.ctx, member), connect.NewRequest(request))
	if err != nil {
		t.Fatalf("retry InvokeMessageAction: %v", err)
	}
	if !retried.Msg.GetInvocation().GetCreatedAt().AsTime().Equal(invocation.GetCreatedAt().AsTime()) {
		t.Fatalf("retry created_at = %v, want %v", retried.Msg.GetInvocation().GetCreatedAt(), invocation.GetCreatedAt())
	}
	collision := *request
	collision.ActionId = "double"
	if _, err := env.messageActions.InvokeMessageAction(withCaller(env.ctx, member), connect.NewRequest(&collision)); connect.CodeOf(err) != connect.CodeAlreadyExists {
		t.Fatalf("request ID collision code = %v, want already_exists", connect.CodeOf(err))
	}

	authorPage, err := env.messageActions.ListMessageActionInvocations(withCaller(env.ctx, env.viewer), connect.NewRequest(&apiv1.ListMessageActionInvocationsRequest{}))
	if err != nil {
		t.Fatalf("ListMessageActionInvocations author: %v", err)
	}
	if len(authorPage.Msg.GetInvocations()) != 1 || authorPage.Msg.GetPage().GetTotalCount() != 1 {
		t.Fatalf("author invocation page = %+v, want one", authorPage.Msg)
	}
	memberPage, err := env.messageActions.ListMessageActionInvocations(withCaller(env.ctx, member), connect.NewRequest(&apiv1.ListMessageActionInvocationsRequest{}))
	if err != nil {
		t.Fatalf("ListMessageActionInvocations member: %v", err)
	}
	if len(memberPage.Msg.GetInvocations()) != 0 {
		t.Fatalf("invoker inbox = %+v, want empty", memberPage.Msg)
	}

	if _, err := env.messageActions.AcknowledgeMessageActionInvocation(withCaller(env.ctx, member), connect.NewRequest(&apiv1.AcknowledgeMessageActionInvocationRequest{InvocationId: invocation.GetId()})); err != nil {
		t.Fatalf("wrong-recipient acknowledgement: %v", err)
	}
	authorPage, err = env.messageActions.ListMessageActionInvocations(withCaller(env.ctx, env.viewer), connect.NewRequest(&apiv1.ListMessageActionInvocationsRequest{}))
	if err != nil || len(authorPage.Msg.GetInvocations()) != 1 {
		t.Fatalf("author inbox after wrong-recipient acknowledgement = %+v, %v", authorPage.Msg, err)
	}
	if _, err := env.messageActions.AcknowledgeMessageActionInvocation(withCaller(env.ctx, env.viewer), connect.NewRequest(&apiv1.AcknowledgeMessageActionInvocationRequest{InvocationId: invocation.GetId()})); err != nil {
		t.Fatalf("author acknowledgement: %v", err)
	}
	authorPage, err = env.messageActions.ListMessageActionInvocations(withCaller(env.ctx, env.viewer), connect.NewRequest(&apiv1.ListMessageActionInvocationsRequest{}))
	if err != nil || len(authorPage.Msg.GetInvocations()) != 0 {
		t.Fatalf("author inbox after acknowledgement = %+v, %v", authorPage.Msg, err)
	}
}

func TestMessageActionsUpdateIsAuthorOnlyAndValidatesIDs(t *testing.T) {
	env := newConnectAPITestEnv(t)
	room := env.createJoinedRoom("message-action-updates")
	created, err := env.messages.CreateMessage(withCaller(env.ctx, env.viewer), connect.NewRequest(&apiv1.CreateMessageRequest{
		RoomId: room.GetId(),
		Body:   "table",
		Actions: &apiv1.MessageActionSet{Actions: []*apiv1.MessageAction{
			{Id: "hit", Label: "Hit"},
			{Id: "hit", Label: "Hit again"},
		}},
	}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("duplicate action CreateMessage code = %v, want invalid_argument", connect.CodeOf(err))
	}

	created, err = env.messages.CreateMessage(withCaller(env.ctx, env.viewer), connect.NewRequest(&apiv1.CreateMessageRequest{
		RoomId: room.GetId(),
		Body:   "table",
		Actions: &apiv1.MessageActionSet{Actions: []*apiv1.MessageAction{
			{Id: "hit", Label: "Hit"},
		}},
	}))
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	message := created.Msg.GetMessage()

	moderator, err := env.core.CreateUser(env.ctx, core.SystemActorID, "action-moderator", "Action Moderator", "password")
	if err != nil {
		t.Fatalf("CreateUser moderator: %v", err)
	}
	if _, err := env.core.JoinRoom(env.ctx, moderator.GetId(), core.KindChannel, moderator.GetId(), room.GetId()); err != nil {
		t.Fatalf("JoinRoom moderator: %v", err)
	}
	if err := env.core.GrantUserRoomPermission(env.ctx, core.SystemActorID, room.GetId(), moderator.GetId(), core.PermMessageManage); err != nil {
		t.Fatalf("Grant message.manage: %v", err)
	}
	if _, err := env.messages.UpdateMessage(withCaller(env.ctx, moderator), connect.NewRequest(&apiv1.UpdateMessageRequest{
		RoomId:  room.GetId(),
		EventId: message.GetId(),
		Actions: &apiv1.MessageActionSet{},
	})); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("moderator action UpdateMessage code = %v, want permission_denied", connect.CodeOf(err))
	}

	updated, err := env.messages.UpdateMessage(withCaller(env.ctx, env.viewer), connect.NewRequest(&apiv1.UpdateMessageRequest{
		RoomId:  room.GetId(),
		EventId: message.GetId(),
		Actions: &apiv1.MessageActionSet{},
	}))
	if err != nil {
		t.Fatalf("author remove actions: %v", err)
	}
	if len(updated.Msg.GetMessage().GetActions()) != 0 || updated.Msg.GetMessage().GetBody() != "table" {
		t.Fatalf("updated message = %+v, want body preserved and actions removed", updated.Msg.GetMessage())
	}
}
