package connectapi

import (
	"context"

	"connectrpc.com/connect"
	"hmans.de/chatto/internal/core"
	apiv1 "hmans.de/chatto/internal/pb/chatto/api/v1"
	corev1 "hmans.de/chatto/internal/pb/chatto/core/v1"
)

const (
	defaultMessageActionInvocationLimit = 50
	maxMessageActionInvocationLimit     = 100
)

type messageActionService struct {
	api *API
}

func (s *messageActionService) InvokeMessageAction(ctx context.Context, req *connect.Request[apiv1.InvokeMessageActionRequest]) (*connect.Response[apiv1.InvokeMessageActionResponse], error) {
	caller, err := requireCaller(ctx)
	if err != nil {
		return nil, err
	}
	invocation, err := s.api.core.Messages().InvokeMessageAction(ctx, core.MessageActionInvokeInput{
		ActorID:        caller.UserID,
		RoomID:         req.Msg.GetRoomId(),
		MessageEventID: req.Msg.GetMessageEventId(),
		ActionID:       req.Msg.GetActionId(),
		RequestID:      req.Msg.GetRequestId(),
	})
	if err != nil {
		return nil, connectError(err)
	}
	return connect.NewResponse(&apiv1.InvokeMessageActionResponse{
		Invocation: messageActionInvocationToAPI(invocation),
	}), nil
}

func (s *messageActionService) ListMessageActionInvocations(ctx context.Context, req *connect.Request[apiv1.ListMessageActionInvocationsRequest]) (*connect.Response[apiv1.ListMessageActionInvocationsResponse], error) {
	caller, err := requireCaller(ctx)
	if err != nil {
		return nil, err
	}
	invocations, err := s.api.core.Messages().ListMessageActionInvocations(ctx, caller.UserID)
	if err != nil {
		return nil, connectError(err)
	}
	limit, offset := apiPagination(req.Msg.GetPage(), defaultMessageActionInvocationLimit, maxMessageActionInvocationLimit)
	page, totalCount, hasMore := apiSlicePage(invocations, limit, offset)
	items := make([]*apiv1.MessageActionInvocation, 0, len(page))
	for _, invocation := range page {
		items = append(items, messageActionInvocationToAPI(invocation))
	}
	return connect.NewResponse(&apiv1.ListMessageActionInvocationsResponse{
		Invocations: items,
		Page:        apiPageInfo(totalCount, hasMore),
	}), nil
}

func (s *messageActionService) AcknowledgeMessageActionInvocation(ctx context.Context, req *connect.Request[apiv1.AcknowledgeMessageActionInvocationRequest]) (*connect.Response[apiv1.AcknowledgeMessageActionInvocationResponse], error) {
	caller, err := requireCaller(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.api.core.Messages().AcknowledgeMessageActionInvocation(ctx, caller.UserID, req.Msg.GetInvocationId()); err != nil {
		return nil, connectError(err)
	}
	return connect.NewResponse(&apiv1.AcknowledgeMessageActionInvocationResponse{Acknowledged: true}), nil
}

func messageActionsToCore(set *apiv1.MessageActionSet) []*corev1.MessageAction {
	if set == nil {
		return nil
	}
	actions := make([]*corev1.MessageAction, 0, len(set.GetActions()))
	for _, action := range set.GetActions() {
		if action == nil {
			actions = append(actions, nil)
			continue
		}
		actions = append(actions, &corev1.MessageAction{
			Id:       action.GetId(),
			Label:    action.GetLabel(),
			Style:    corev1.MessageActionStyle(action.GetStyle()),
			Disabled: action.GetDisabled(),
		})
	}
	return actions
}

func messageActionsToAPI(actions []*corev1.MessageAction) []*apiv1.MessageAction {
	result := make([]*apiv1.MessageAction, 0, len(actions))
	for _, action := range actions {
		if action == nil {
			continue
		}
		result = append(result, &apiv1.MessageAction{
			Id:       action.GetId(),
			Label:    action.GetLabel(),
			Style:    apiv1.MessageActionStyle(action.GetStyle()),
			Disabled: action.GetDisabled(),
		})
	}
	return result
}

func messageActionInvocationToAPI(invocation *corev1.MessageActionInvocation) *apiv1.MessageActionInvocation {
	if invocation == nil {
		return nil
	}
	return &apiv1.MessageActionInvocation{
		Id:             invocation.GetId(),
		RoomId:         invocation.GetRoomId(),
		MessageEventId: invocation.GetMessageEventId(),
		ActionId:       invocation.GetActionId(),
		ActorId:        invocation.GetActorId(),
		CreatedAt:      invocation.GetCreatedAt(),
	}
}
