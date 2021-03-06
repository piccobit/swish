/*  Part of SWISH

    Author:        Jan Wielemaker
    E-mail:        J.Wielemaker@cs.vu.nl
    WWW:           http://www.swi-prolog.org
    Copyright (C): 2017, VU University Amsterdam
			 CWI Amsterdam
    All rights reserved.

    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions
    are met:

    1. Redistributions of source code must retain the above copyright
       notice, this list of conditions and the following disclaimer.

    2. Redistributions in binary form must reproduce the above copyright
       notice, this list of conditions and the following disclaimer in
       the documentation and/or other materials provided with the
       distribution.

    THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
    "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
    LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS
    FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
    COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT,
    INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
    BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
    LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
    CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
    LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN
    ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
    POSSIBILITY OF SUCH DAMAGE.
*/

:- module(swish_plugin_user_profile, []).
:- use_module(library(option)).
:- use_module(library(user_profile)).
:- use_module(library(http/http_dispatch)).
:- use_module(library(http/http_session)).
:- use_module(library(http/http_wrapper)).
:- use_module(library(http/html_write)).
:- use_module(library(http/http_json)).
:- use_module(library(apply)).
:- use_module(library(error)).
:- use_module(library(lists)).
:- use_module(library(debug)).
:- use_module(library(broadcast)).

:- use_module(swish(lib/config), []).
:- use_module(swish(lib/login)).
:- use_module(swish(lib/bootstrap)).
:- use_module(swish(lib/form)).


/** <module> User profile configuration

Complementary to authentication, this module  configures the maintenance
of user profiles.

There are several  places  where  we   need  interaction  with  the user
profile:

  - Prolog gathering and maintenance

    1. If a new user is found we want to welcome the user and
       optionally complete the profile.  For example, we may wish
       to ask the `email` for the new user and start a process to
       verify this.
    2. A user must be able to edit and delete his/her profile.
    3. A user must be able to migrate a profile, probably only from
       a profile with the same verified email address.

  - Profile usage

    1. Claim ownership
       - To files
       - To comments
    2. Grant access.  Access points in SWISH should be
       - Execution of goals
	 - Normal sandboxed/not-sandboxed operations
         - Grant/Deny access to certain sensitive (database)
           predicates.
       - Viewing/using code
       - Saving code
         - Save in general (e.g., do not save when anonymous)
         - Make revisions to files that are not yours
         - Save non-versioned files
         - Add modules to the version store?
    3. Send notifications
       - By mail
       - Maintain notification queue for a user
*/

:- http_handler(swish(user_profile),   user_profile,   [id(user_profile)]).
:- http_handler(swish(save_profile),   save_profile,   []).
:- http_handler(swish(update_profile), update_profile,   []).
:- http_handler(swish(delete_profile), delete_profile, []).


:- multifile
    swish_config:reply_logged_in/1,     % +Options
    swish_config:reply_logged_out/1,    % +Options
    swish_config:user_profile/3.        % +Request, +ServerID, -Info


		 /*******************************
		 *            LOGIN		*
		 *******************************/

%!  swish_config:reply_logged_in(+Options)
%
%   Hook logins from federated identity provides.  Options processed:
%
%     - user_info(+UserInfo:Dict)
%     Provides information about the user provided by the external
%     identity provider.

swish_config:reply_logged_in(Options) :-
    option(user_info(Info), Options),
    known_profile(Info, ProfileID),
    !,
    associate_profile(ProfileID),
    reply_html_page(
        title('Logged in'),
        [ h4('Welcome back'),
          p(\last_login(ProfileID)),
          \login_continue_button
        ]).
swish_config:reply_logged_in(Options) :-
    option(user_info(Info), Options),
    create_profile(Info, Info.get(identity_provider), User),
    !,
    http_open_session(_SessionID, []),
    associate_profile(User),
    update_last_login(User),
    reply_html_page(
        title('Logged in'),
        [ h4('Welcome'),
          p([ 'You appear to be a new user.  You may inspect, update \c
               and delete your profile using the drop-down menu associated \c
               with the login/logout widget.'
            ]),
          \login_continue_button
        ]).

%!  known_profile(+Info, -ProfileID) is semidet.
%
%   True when ProfileID is the profile  identifier for the authenticated
%   user.

known_profile(Info, User) :-
    IdProvider = Info.identity_provider,
    profile_default(IdProvider, Info, external_identity(ID)),
    profile_property(User, external_identity(ID)),
    profile_property(User, identity_provider(IdProvider)).

%!  associate_profile(+ProfileID) is det.
%
%   Associate the current session with   the given ProfileID. Broadcasts
%   SWISH event profile(ProfileID).

associate_profile(ProfileID) :-
    http_session_assert(profile_id(ProfileID)),
    broadcast(swish(profile(ProfileID))).


%!  swish_config:reply_logged_out(+Options)
%
%   Perform a logout, removing the link to the session

swish_config:reply_logged_out(Options) :-
    http_in_session(_),
    !,
    forall(http_session_retract(profile_id(ProfileID)),
           broadcast(swish(logout(ProfileID)))),
    reply_logged_out_page(Options).
swish_config:reply_logged_out(_) :-
    broadcast(swish(logout(-))).        % ?


%!  create_profile(+UserInfo, +IDProvider, -User)
%
%   Create a new user profile.

create_profile(UserInfo, IdProvider, User) :-
    user_profile_values(UserInfo, IdProvider, Defaults),
    profile_create(User, Defaults).

user_profile_values(UserInfo, IdProvider, Defaults) :-
    findall(Default,
            profile_default(IdProvider, UserInfo, Default),
            Defaults).

profile_default(IdProvider, UserInfo, Default) :-
    (   nonvar(Default)
    ->  functor(Default, Name, 1)
    ;   true
    ),
    user_profile:attribute(Name, _, _),
    user_profile:attribute_mapping(Name, IdProvider, UName),
    catch(profile_canonical_value(Name, UserInfo.get(UName), Value),
          error(type_error(_,_),_),
          fail),
    Default =.. [Name,Value].

%!  last_login(+User)//
%
%   Indicate when the user used this server for the last time.

last_login(User) -->
    { profile_property(User, last_login(TimeStamp)),
      profile_property(User, last_peer(Peer)),
      format_time(string(Time), '%+', TimeStamp),
      update_last_login(User)
    },
    !,
    html('Last login: ~w from ~w'-[Time, Peer]).
last_login(User) -->
    { update_last_login(User) }.

update_last_login(User) :-
    http_current_request(Request),
    http_peer(Request, Peer),
    get_time(Now),
    NowInt is round(Now),
    set_profile(User, last_peer(Peer)),
    set_profile(User, last_login(NowInt)).

% ! swish_config:user_profile(+Request, -Profile) is semidet.
%
%   Provide the profile for the current user.

swish_config:user_profile(_Request, Profile) :-
    http_in_session(_SessionID),
    http_session_data(profile_id(User)),
    current_profile(User, Profile0),
    Profile = Profile0.put(user_id, User).


		 /*******************************
		 *         PROFILE GUI		*
		 *******************************/

%!  user_profile(+Request)
%
%   Emit an HTML page that allows for   viewing, updating and deleting a
%   user profile.

user_profile(_Request) :-
    http_in_session(_SessionID),
    http_session_data(profile_id(User)),
    current_profile(User, Profile),
    findall(Field, user_profile:attribute(Field, _, _), Fields),
    convlist(bt_field(Profile), Fields, FieldWidgets),
    buttons(Buttons),
    append(FieldWidgets, Buttons, Widgets),
    reply_html_page(
        title('User profile'),
        \bt_form(Widgets,
                 [ class('form-horizontal'),
                   label_columns(sm-3)
                 ])).

bt_field(Profile, Name, input(Name, IType, Options)) :-
    user_profile:attribute(Name, Type, AOptions),
    input_type(Type, IType),
    \+ option(hidden(true), AOptions),
    phrase(( (value_opt(Profile, Type, Name) -> [] ; []),
             (access_opt(AOptions)           -> [] ; []),
             (data_type_opt(Type)            -> [] ; [])
           ), Options).

input_type(boolean, checkbox) :-
    !.
input_type(_,       text).

value_opt(Profile, Type, Name) -->
    { Value0 = Profile.get(Name),
      display_value(Type, Value0, Value)
    },
    [ value(Value) ].
access_opt(AOptions) -->
    { option(access(ro), AOptions) },
    [ disabled(true) ].
data_type_opt(_Type) -->                % TBD
    [].

display_value(time_stamp(Format), Stamp, Value) :-
    !,
    format_time(string(Value), Format, Stamp).
display_value(_, Value0, Value) :-
    atomic(Value0),
    !,
    Value = Value0.
display_value(_, Value0, Value) :-
    format(string(Value), '~w', [Value0]).

buttons(
    [ button_group(
          [ button(done, button,
                   [ type(primary),
                     data([dismiss(modal)])
                   ]),
            button(save, submit,
                   [ type(success),
                     label('Save profile'),
                     data([action(SaveHREF)])
                   ]),
            button(reset, submit,
                   [ type(warning),
                     label('Reset profile'),
                     data([action(UpdateHREF), form_data(false)])
                   ]),
            button(delete, submit,
                   [ type(danger),
                     label('Delete profile'),
                     data([action(DeleteHREF), form_data(false)])
                   ])
          ],
          [
          ])
    ]) :-
    http_link_to_id(save_profile, [], SaveHREF),
    http_link_to_id(update_profile, [], UpdateHREF),
    http_link_to_id(delete_profile, [], DeleteHREF).


		 /*******************************
		 *        MODIFY PROFILE	*
		 *******************************/

%!  save_profile(+Request)
%
%   Update the profile for the  current  user.   The  form  sends a JSON
%   object that contains a value for all non-disabled fields that have a
%   non-null value.

save_profile(Request) :-
    http_read_json_dict(Request, Dict),
    debug(profile(update), 'Got ~p', [Dict]),
    http_in_session(_SessionID),
    http_session_data(profile_id(User)),
    dict_pairs(Dict, _, Pairs),
    maplist(validate_term, Pairs, Validate),
    catch(validate_form(Dict, Validate), E, true),
    (   var(E)
    ->  save_profile(User, Dict),
        current_profile(User, Profile),
        reply_json_dict(_{status:success, profile:Profile})
    ;   message_to_string(E, Msg),
        Error = _{code:form_error, data:Msg},
        reply_json_dict(_{status:error, error:Error})
    ).

validate_term(Name-_, field(Name, _Value, [strip,default("")|Options])) :-
    user_profile:attribute(Name, Type, FieldOptions),
    (   (   option(access(ro), FieldOptions)
        ;   option(hidden(true), FieldOptions)
        )
    ->  permission_error(modify, profile, Name)
    ;   true
    ),
    type_options(Type, Options).

type_options(Type, [Type]).

%!  save_profile(+User, +Dict) is det.
%
%   Update the profile for User with values from Dict.

save_profile(User, Dict) :-
    dict_pairs(Dict, _, Pairs),
    maplist(save_profile_field(User), Pairs).

save_profile_field(User, Name-Value) :-
    (   Term =.. [Name,Old],
        profile_property(User, Term)
    ->  true
    ;   Old = ""
    ),
    update_profile_field(User, Name, Old, Value).

update_profile_field(User, Name, Old, "") :-
    !,
    profile_remove(User, Name),
    broadcast(user_profile(modified(User, Name, Old, ""))).
update_profile_field(User, Name, Old, New0) :-
    profile_canonical_value(Name, New0, New),
    (   Old == New
    ->  true
    ;   set_profile(User, Name=New),
        broadcast(user_profile(modified(User, Name, Old, New)))
    ).


%!  update_profile(+Request)
%
%   Update a profile with new information from the identity provider

update_profile(Request) :-
    swish_config:user_info(Request, Server, UserInfo),
    http_in_session(_SessionID),
    http_session_data(profile_id(User)),
    user_profile_values(UserInfo, Server, ServerInfo),
    dict_pairs(ServerInfo, _, Pairs),
    maplist(update_profile_field(User), Pairs),
    current_profile(User, Profile),
    reply_json_dict(_{status:success, profile:Profile}).

update_profile_field(User, Name-Value) :-
    set_profile(User, Name=Value).

%!  delete_profile(+Request)
%
%   Completely delete the profile for the current user

delete_profile(_Request) :-
    http_in_session(SessionID),
    http_session_data(profile_id(User)),
    http_close_session(SessionID),      % effectively logout
    profile_remove(User),
    reply_json_dict(true).
